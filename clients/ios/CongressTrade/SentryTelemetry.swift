import Foundation
import Sentry

/// Native Sentry telemetry and crash reporting for Congress.Trade iOS.
///
/// DSN is read only from Info.plist (`SENTRY_DSN`). There is no hardcoded
/// fallback — missing or empty skips init so a leaked default cannot be
/// pointed at the wrong project.
///
/// Scope for CT (filings / PII-sensitive): errors, native crashes, app hangs,
/// and error-only Session Replay (session sample 0%, same PII bar as web).
/// No screenshots, no view hierarchy, no default PII.
enum SentryTelemetry {
    static func start() {
        if isScreenshotOrUITestLaunch { return }

        guard let dsn = plistString("SENTRY_DSN"), !dsn.isEmpty else { return }

        let releaseName = plistString("CFBundleShortVersionString")
        let dist = plistString("CFBundleVersion")

        SentrySDK.start { options in
            options.dsn = dsn
            #if DEBUG
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
            if let releaseName, !releaseName.isEmpty {
                options.releaseName = releaseName
            }
            if let dist, !dist.isEmpty {
                options.dist = dist
            }
            options.tracesSampleRate = 0.2
            options.profilesSampleRate = 0.1
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0
            options.sessionReplay.onErrorSampleRate = 1.0
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            options.beforeSend = { event in
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in [
                        "token", "key", "secret", "auth", "password",
                        "session", "bearer", "email", "code"
                    ] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }

    /// Asc / UITest / screenshot launches stay silent so App Store shots do not
    /// mint noise on the congress-trade project.
    private static var isScreenshotOrUITestLaunch: Bool {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-ASCScreenshots") { return true }
        if args.contains("-screenshotPaywall") { return true }
        if args.contains("-showSubscribe") { return true }
        if ProcessInfo.processInfo.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return true
        }
        return false
    }

    /// Info.plist string, treating unsubstituted `$(VAR)` build settings as missing.
    private static func plistString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasPrefix("$(") { return nil }
        return trimmed
    }
}
