/**
 * src/billing/appleCrypto.ts
 *
 * Minimal ASN.1 DER + X.509 primitives for verifying Apple's StoreKit 2 /
 * App Store Server Notifications signed JWS payloads. Apple signs both with
 * a compact ES256 JWS whose protected header carries the leaf→intermediate
 * certificate chain (`x5c`, base64-DER, RFC 7515 §4.1.6); trust is anchored
 * to Apple's published Root CA - G3 (see appleRootCert.ts), so verification
 * never needs a network call.
 *
 * Hand-rolled (no npm crypto/X.509 dependency) so this module typechecks and
 * runs unmodified under both the Cloudflare Worker and the Deno runtime this
 * app dual-targets — the same constraint admin/access.ts's hand-rolled JWKS +
 * RS256 JWT verifier already works under. WebCrypto (`crypto.subtle`) is the
 * only crypto primitive used; DER parsing only ever reads, never trusts, the
 * peer-supplied bytes without a subsequent signature check against a key WE
 * derived (either from the next cert up the chain, or the pinned root).
 */

// ---------------------------------------------------------------------------
// Low-level DER TLV reader
// ---------------------------------------------------------------------------

export interface Tlv {
  tag: number;
  /** Offset of the tag byte — start of the FULL encoded TLV (header+content). */
  start: number;
  contentStart: number;
  contentEnd: number;
  /** End of the full TLV (== contentEnd; kept distinct for readability at call sites). */
  end: number;
}

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_CONTEXT_0 = 0xa0;

function readLength(buf: Uint8Array, offset: number): { length: number; next: number } {
  if (offset >= buf.length) throw new Error('DER: unexpected end of buffer reading length');
  const first = buf[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) throw new Error('DER: unsupported length encoding');
  if (offset + 1 + numBytes > buf.length) throw new Error('DER: length bytes exceed buffer');
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i];
  return { length, next: offset + 1 + numBytes };
}

export function readTlv(buf: Uint8Array, offset: number): Tlv {
  if (offset >= buf.length) throw new Error('DER: unexpected end of buffer');
  const start = offset;
  const tag = buf[offset];
  const { length, next } = readLength(buf, offset + 1);
  const contentStart = next;
  const contentEnd = contentStart + length;
  if (contentEnd > buf.length) throw new Error('DER: content length exceeds buffer');
  return { tag, start, contentStart, contentEnd, end: contentEnd };
}

/** Every immediate child TLV inside a constructed TLV's content region. */
export function readChildren(buf: Uint8Array, tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let offset = tlv.contentStart;
  while (offset < tlv.contentEnd) {
    const child = readTlv(buf, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function fullBytes(buf: Uint8Array, tlv: Tlv): Uint8Array {
  return buf.slice(tlv.start, tlv.end);
}
function contentBytes(buf: Uint8Array, tlv: Tlv): Uint8Array {
  return buf.slice(tlv.contentStart, tlv.contentEnd);
}

/** Decode a DER OBJECT IDENTIFIER's content bytes into dotted notation. */
export function decodeOid(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error('DER: empty OID');
  const first = bytes[0];
  const arcs = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      arcs.push(value >>> 0);
      value = 0;
    }
  }
  return arcs.join('.');
}

// ---------------------------------------------------------------------------
// EC OIDs / algorithm mapping
// ---------------------------------------------------------------------------

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_P256 = '1.2.840.10045.3.1.7';
const OID_P384 = '1.3.132.0.34';
const OID_P521 = '1.3.132.0.35';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_ECDSA_SHA384 = '1.2.840.10045.4.3.3';
const OID_ECDSA_SHA512 = '1.2.840.10045.4.3.4';

export type EcCurve = 'P-256' | 'P-384' | 'P-521';

function curveFromOid(oid: string): EcCurve {
  if (oid === OID_P256) return 'P-256';
  if (oid === OID_P384) return 'P-384';
  if (oid === OID_P521) return 'P-521';
  throw new Error(`DER: unsupported EC curve OID ${oid}`);
}

export function curveByteSize(curve: EcCurve): number {
  return curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66;
}

function hashForSigAlgOid(oid: string): 'SHA-256' | 'SHA-384' | 'SHA-512' {
  if (oid === OID_ECDSA_SHA256) return 'SHA-256';
  if (oid === OID_ECDSA_SHA384) return 'SHA-384';
  if (oid === OID_ECDSA_SHA512) return 'SHA-512';
  throw new Error(`DER: unsupported signature algorithm OID ${oid}`);
}

// ---------------------------------------------------------------------------
// X.509 certificate parsing (EC-signed / EC-keyed certs only — sufficient for
// Apple's App Store Server chains).
// ---------------------------------------------------------------------------

export interface ParsedCert {
  /** Full encoded TBSCertificate (tag+length+content) — the exact bytes the issuer signed. */
  tbsRaw: Uint8Array;
  /** The certificate's own outer signatureAlgorithm OID (ecdsa-with-SHAxxx). */
  sigAlgOid: string;
  /** DER SEQUENCE{r,s} content of the outer signatureValue (BIT STRING padding byte stripped). */
  signatureRawDer: Uint8Array;
  /** Full encoded SubjectPublicKeyInfo — directly importable via `crypto.subtle.importKey('spki', ...)`. */
  spkiRaw: Uint8Array;
  spkiCurve: EcCurve;
  notBefore: Date;
  notAfter: Date;
}

function decodeTime(buf: Uint8Array, tlv: Tlv): Date {
  const raw = new TextDecoder().decode(contentBytes(buf, tlv));
  if (tlv.tag === TAG_UTC_TIME) {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
    if (!m) throw new Error('DER: malformed UTCTime');
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  if (tlv.tag === TAG_GENERALIZED_TIME) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
    if (!m) throw new Error('DER: malformed GeneralizedTime');
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  throw new Error('DER: unsupported time tag');
}

/**
 * Parse a DER-encoded X.509 certificate. Only supports EC-keyed, EC-signed
 * certificates (id-ecPublicKey / ecdsa-with-SHAxxx) — the only shape Apple's
 * App Store Server chains use. Never trusts anything beyond structure +
 * declared validity window; the caller is responsible for signature checks.
 */
export function parseCertificate(der: Uint8Array): ParsedCert {
  const cert = readTlv(der, 0);
  if (cert.tag !== TAG_SEQUENCE) throw new Error('cert: expected outer SEQUENCE');
  const [tbs, sigAlg, sigValue] = readChildren(der, cert);
  if (!tbs || !sigAlg || !sigValue) throw new Error('cert: malformed top-level structure');
  if (tbs.tag !== TAG_SEQUENCE || sigAlg.tag !== TAG_SEQUENCE || sigValue.tag !== TAG_BIT_STRING) {
    throw new Error('cert: unexpected top-level tag shape');
  }

  const sigAlgChildren = readChildren(der, sigAlg);
  if (sigAlgChildren[0]?.tag !== TAG_OID) throw new Error('cert: signatureAlgorithm missing OID');
  const sigAlgOid = decodeOid(contentBytes(der, sigAlgChildren[0]));

  const sigContent = contentBytes(der, sigValue);
  if (sigContent.length < 1 || sigContent[0] !== 0x00) {
    throw new Error('cert: unexpected BIT STRING unused-bits padding');
  }
  const signatureRawDer = sigContent.slice(1);

  const tbsChildren = readChildren(der, tbs);
  let idx = 0;
  if (tbsChildren[idx]?.tag === TAG_CONTEXT_0) idx++; // optional `version [0]`
  idx++; // serialNumber
  idx++; // signature (AlgorithmIdentifier) — inner copy; outer sigAlg is authoritative
  const issuer = tbsChildren[idx++];
  const validity = tbsChildren[idx++];
  const subject = tbsChildren[idx++];
  const spki = tbsChildren[idx++];
  if (!issuer || !validity || !subject || !spki) throw new Error('cert: malformed TBSCertificate');
  if (validity.tag !== TAG_SEQUENCE || spki.tag !== TAG_SEQUENCE) {
    throw new Error('cert: unexpected TBSCertificate field tag shape');
  }

  const validityChildren = readChildren(der, validity);
  if (!validityChildren[0] || !validityChildren[1]) throw new Error('cert: malformed Validity');
  const notBefore = decodeTime(der, validityChildren[0]);
  const notAfter = decodeTime(der, validityChildren[1]);

  const spkiChildren = readChildren(der, spki);
  const spkiAlg = spkiChildren[0];
  if (!spkiAlg || spkiAlg.tag !== TAG_SEQUENCE) throw new Error('cert: malformed SubjectPublicKeyInfo');
  const spkiAlgChildren = readChildren(der, spkiAlg);
  if (spkiAlgChildren[0]?.tag !== TAG_OID) throw new Error('cert: SubjectPublicKeyInfo missing algorithm OID');
  const spkiAlgOid = decodeOid(contentBytes(der, spkiAlgChildren[0]));
  if (spkiAlgOid !== OID_EC_PUBLIC_KEY) {
    throw new Error(`cert: unsupported public key algorithm ${spkiAlgOid} (only id-ecPublicKey is supported)`);
  }
  if (spkiAlgChildren[1]?.tag !== TAG_OID) throw new Error('cert: SubjectPublicKeyInfo missing EC curve OID');
  const spkiCurve = curveFromOid(decodeOid(contentBytes(der, spkiAlgChildren[1])));

  return {
    tbsRaw: fullBytes(der, tbs),
    sigAlgOid,
    signatureRawDer,
    spkiRaw: fullBytes(der, spki),
    spkiCurve,
    notBefore,
    notAfter,
  };
}

// ---------------------------------------------------------------------------
// ECDSA signature format conversion (X.509 signatures are DER SEQUENCE{r,s};
// WebCrypto's ECDSA verify expects the fixed-width raw r||s / IEEE P1363 form).
// ---------------------------------------------------------------------------

function trimIntToFixedWidth(intBytes: Uint8Array, size: number): Uint8Array {
  let b = intBytes;
  // Strip a single DER positive-sign guard byte (0x00 prefix before a byte with the high bit set).
  if (b.length > 1 && b[0] === 0x00 && (b[1] & 0x80) !== 0) b = b.slice(1);
  // Defensively strip any further leading zero bytes beyond the curve's width.
  while (b.length > size && b[0] === 0x00) b = b.slice(1);
  if (b.length > size) throw new Error('ecdsa signature: integer too wide for curve size');
  const out = new Uint8Array(size);
  out.set(b, size - b.length);
  return out;
}

/** DER SEQUENCE{INTEGER r, INTEGER s} -> fixed-width raw r||s (WebCrypto ECDSA verify format). */
export function derEcdsaSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const seq = readTlv(der, 0);
  if (seq.tag !== TAG_SEQUENCE) throw new Error('ecdsa signature: expected SEQUENCE');
  const [rTlv, sTlv] = readChildren(der, seq);
  if (!rTlv || !sTlv || rTlv.tag !== TAG_INTEGER || sTlv.tag !== TAG_INTEGER) {
    throw new Error('ecdsa signature: malformed r/s pair');
  }
  const r = trimIntToFixedWidth(contentBytes(der, rTlv), size);
  const s = trimIntToFixedWidth(contentBytes(der, sTlv), size);
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

// ---------------------------------------------------------------------------
// Certificate signature verification (one link in the chain)
// ---------------------------------------------------------------------------

/**
 * Verify that `cert` was signed by the private key matching `issuerSpkiDer`.
 * `cert.tbsRaw` is the exact bytes the issuer's private key signed over.
 */
export async function verifyCertSignedBy(
  cert: ParsedCert,
  issuerSpkiDer: Uint8Array,
  issuerCurve: EcCurve,
): Promise<boolean> {
  const hash = hashForSigAlgOid(cert.sigAlgOid);
  const size = curveByteSize(issuerCurve);
  const rawSig = derEcdsaSignatureToRaw(cert.signatureRawDer, size);
  const key = await crypto.subtle.importKey(
    'spki',
    issuerSpkiDer as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: issuerCurve },
    false,
    ['verify'],
  );
  return crypto.subtle.verify({ name: 'ECDSA', hash }, key, rawSig as unknown as ArrayBuffer, cert.tbsRaw as unknown as ArrayBuffer);
}
