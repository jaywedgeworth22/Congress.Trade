import SwiftUI

/// Full-screen brand splash: the eagle *flies* along a curved path (not a
/// simple scale). Enters large from off-screen, banks through center, then
/// recedes into the header brand slot. Mirrors the website flight path.
struct EagleSplashView: View {
    var onFinished: () -> Void

    @State private var progress: CGFloat = 0
    @State private var finished = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Peak size while soaring through the viewport.
    private let peakSize: CGFloat = 240
    /// Final header mark size.
    private let settledSize: CGFloat = 32
    private let duration: TimeInterval = 2.1

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let nest = CGPoint(
                x: 16 + settledSize / 2,
                y: geo.safeAreaInsets.top + 12 + settledSize / 2
            )

            // Cubic path: BR offscreen → high bank → mid soar → header nest
            let p0 = CGPoint(x: W * 1.15, y: H * 0.74)
            let p1 = CGPoint(x: W * 0.70, y: H * 0.18)
            let p2 = CGPoint(x: W * 0.40, y: H * 0.50)
            let p3 = nest

            let t = ease(progress)
            let pos = cubic(p0, p1, p2, p3, t)
            let deriv = cubicDeriv(p0, p1, p2, p3, t)
            let bank = atan2(deriv.y, deriv.x) * 180 / .pi + 12
            let beat = sin(progress * .pi * 7) * (1 - progress) * 7
            let size = peakSize * sizeEnvelope(progress)
            let bgOp: Double = progress < 0.85 ? 1.0 : max(0, 1.0 - Double((progress - 0.85) / 0.15))

            ZStack {
                Color(red: 0.031, green: 0.067, blue: 0.12)
                    .opacity(finished ? 0 : bgOp)
                    .ignoresSafeArea()

                // Ground shadow for depth
                Ellipse()
                    .fill(Color.black.opacity(0.28 * Double(size / peakSize)))
                    .frame(width: size * 0.55, height: size * 0.14)
                    .position(x: pos.x, y: pos.y + size * 0.42)
                    .opacity(finished ? 0 : 1)

                Image("BrandLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .shadow(color: .black.opacity(0.45), radius: 18 * (size / peakSize), y: 12)
                    .rotationEffect(.degrees(bank + beat))
                    .position(pos)
                    .opacity(finished ? 0 : 1)
            }
            .allowsHitTesting(false)
            .onAppear { runSequence() }
        }
    }

    private func runSequence() {
        if reduceMotion {
            finished = true
            onFinished()
            return
        }
        withAnimation(.linear(duration: duration)) {
            progress = 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.05) {
            withAnimation(.easeOut(duration: 0.3)) {
                finished = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
                onFinished()
            }
        }
    }

    // MARK: - Path math

    private func ease(_ t: CGFloat) -> CGFloat {
        // Smooth overall easing (approach + settle)
        if t < 0.5 { return 2 * t * t }
        return 1 - pow(-2 * t + 2, 1.85) / 2
    }

    /// Size envelope: approach small→large, then recede large→settled.
    private func sizeEnvelope(_ raw: CGFloat) -> CGFloat {
        let end = settledSize / peakSize
        if raw < 0.38 {
            let u = raw / 0.38
            let ease = 1 - pow(1 - u, 2.2)
            return 0.42 + 0.58 * ease
        }
        let v = min(1, max(0, (raw - 0.38) / 0.62))
        let ee = v < 0.5 ? 2 * v * v : 1 - pow(-2 * v + 2, 2) / 2
        return 1.0 + (end - 1.0) * ee
    }

    private func cubic(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint, _ t: CGFloat) -> CGPoint {
        let u = 1 - t
        let x = u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x
        let y = u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y
        return CGPoint(x: x, y: y)
    }

    private func cubicDeriv(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint, _ t: CGFloat) -> CGPoint {
        let u = 1 - t
        let x = 3*u*u*(b.x - a.x) + 6*u*t*(c.x - b.x) + 3*t*t*(d.x - c.x)
        let y = 3*u*u*(b.y - a.y) + 6*u*t*(c.y - b.y) + 3*t*t*(d.y - c.y)
        return CGPoint(x: x, y: y)
    }
}
