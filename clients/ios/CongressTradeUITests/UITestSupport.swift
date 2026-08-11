import XCTest

/// Shared harness for the Congress.Trade UI tests.
///
/// Everything here drives the app through the accessibility API (XCUITest),
/// never the host mouse/keyboard — running these must never steal foreground
/// focus from whoever is working at the machine. No AppleScript, no `open -a`,
/// no Simulator.app automation anywhere in this target or its driving script.
///
/// The app loads live data from congress.trade, so every wait is an explicit
/// expectation or a bounded poll with a stated failure reason — never a fixed
/// sleep that "usually" works. A scene that will not finish loading fails the
/// test loudly instead of quietly yielding a screenshot of a spinner.
enum UITestTimeout {
    /// Cold launch + first network round trip against production.
    static let launch: TimeInterval = 90
    /// A tab that renders from already-fetched store state.
    static let scene: TimeInterval = 45
    /// A sheet/popover animating in over content already on screen.
    static let presentation: TimeInterval = 15
}

/// The five primary tabs, in on-screen order (mirrors `AppTab` in App.swift).
enum AppScene: String, CaseIterable {
    case trends
    case trades
    case people
    case delivery
    case settings

    /// Accessibility identifier applied to the tab's root view in App.swift.
    /// These five identifiers are the *only* app-side additions this harness
    /// requires: they sit on the `TabView` children, which are stable, rather
    /// than on view internals that other lanes are actively rewriting.
    var identifier: String { "tab.\(rawValue)" }

    /// Visible tab-bar button label.
    var tabLabel: String {
        switch self {
        case .trends: return "Trends"
        case .trades: return "Trades"
        case .people: return "Directory"
        case .delivery: return "Delivery"
        case .settings: return "Settings"
        }
    }

    /// Ordinal prefix for screenshot filenames, so a harvested run sorts in
    /// the order the App Store listing presents the scenes.
    var captureIndex: Int {
        (AppScene.allCases.firstIndex(of: self) ?? 0) + 1
    }
}

extension XCUIApplication {
    /// Launches the app configured for deterministic capture.
    ///
    /// `-UITestMode` is read by nothing in the app today; it is passed so a
    /// future change can suppress non-deterministic chrome (e.g. a one-shot
    /// disclaimer reveal) without the tests changing shape.
    static func launchForUITests(colorScheme: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-UITestMode", "YES"]
        if let colorScheme {
            // Matches @AppStorage("app_color_scheme") in CongressTradeApp.
            app.launchArguments += ["-app_color_scheme", colorScheme]
        }
        app.launch()
        return app
    }
}

extension XCTestCase {
    /// Waits until `element` satisfies `predicate`, or the timeout expires.
    /// Returns whether the condition was met, so callers can assert with a
    /// message that says what actually went wrong.
    func wait(
        until predicate: String,
        on element: XCUIElement,
        timeout: TimeInterval = UITestTimeout.presentation
    ) -> Bool {
        let exp = expectation(for: NSPredicate(format: predicate), evaluatedWith: element)
        return XCTWaiter().wait(for: [exp], timeout: timeout) == .completed
    }

    /// Waits for the tab bar, i.e. the app finished cold launch.
    @discardableResult
    func waitForAppReady(_ app: XCUIApplication) -> XCUIElement {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(
            tabBar.waitForExistence(timeout: UITestTimeout.launch),
            "Tab bar never appeared — the app did not finish launching within \(Int(UITestTimeout.launch))s."
        )
        return tabBar
    }

    /// Selects a tab by its visible label and waits until it is actually shown.
    func selectTab(_ scene: AppScene, in app: XCUIApplication) {
        let button = app.tabBars.buttons[scene.tabLabel]
        XCTAssertTrue(
            button.waitForExistence(timeout: UITestTimeout.scene),
            "Tab '\(scene.tabLabel)' is missing from the tab bar."
        )
        button.tap()
        XCTAssertTrue(
            wait(until: "isSelected == true", on: button),
            "Tab '\(scene.tabLabel)' did not become selected after tapping it."
        )
        // The tab identifiers added in App.swift confirm the *content* switched,
        // not just the tab-bar button's selected state.
        let root = app.descendants(matching: .any).matching(identifier: scene.identifier).firstMatch
        XCTAssertTrue(
            root.waitForExistence(timeout: UITestTimeout.scene),
            "Tab '\(scene.tabLabel)' is selected but its root view (\(scene.identifier)) never appeared."
        )
    }

    /// Blocks until the scene has settled into real content.
    ///
    /// "Settled" means no activity indicator is on screen, the Trends tab's
    /// explicit "Loading trends…" label is gone, enough static text has
    /// rendered to be a real screen, and the element count has stopped moving.
    /// A scene still spinning when the timeout expires **fails** — a spinner
    /// must never reach an App Store slot.
    func waitForSceneContent(
        _ scene: AppScene,
        in app: XCUIApplication,
        timeout: TimeInterval = UITestTimeout.scene
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        var lastReason = "never evaluated"

        while Date() < deadline {
            if app.activityIndicators.count > 0 {
                lastReason = "an activity indicator is still on screen"
            } else if app.staticTexts["Loading trends…"].exists {
                lastReason = "Trends is still showing its loading label"
            } else if app.staticTexts.count < 3 {
                lastReason = "only \(app.staticTexts.count) static text element(s) rendered"
            } else if let unsettled = unsettledReason(in: app, before: deadline) {
                lastReason = unsettled
            } else {
                return
            }
            usleep(250_000)
        }

        XCTFail(
            "\(scene.tabLabel) never finished loading within \(Int(timeout))s — \(lastReason). "
            + "Refusing to capture a spinner."
        )
    }

    /// Waits for the view hierarchy to stop changing, rather than sleeping a
    /// fixed interval and hoping the fade finished. Returns `nil` once the
    /// element count is identical across three consecutive samples, or a
    /// human-readable reason if it was still moving at the deadline.
    private func unsettledReason(in app: XCUIApplication, before deadline: Date) -> String? {
        var stableSamples = 0
        var previous = app.staticTexts.count

        while Date() < deadline {
            usleep(200_000)
            let current = app.staticTexts.count
            if current == previous {
                stableSamples += 1
                if stableSamples >= 2 { return nil }
            } else {
                stableSamples = 0
                previous = current
            }
        }
        return "the view hierarchy was still changing (last count \(previous))"
    }

    /// Opens a trade's detail sheet and returns an element that proves it is up.
    ///
    /// `TradeCard` nests *three* buttons per row — ticker logo, asset title,
    /// politician line — and the ticker and politician ones open **different**
    /// sheets. Rather than guess structurally, the row button carries
    /// `trades.row` (FeedDashboardView.swift), so this is one unambiguous query.
    ///
    /// An earlier version scanned the scroll view's buttons and filtered them by
    /// `isHittable`. Do not reintroduce that: probing `isHittable` on an element
    /// whose activation point cannot be resolved — the "Sort by Date" control,
    /// as it happens — makes XCTest record a failure, which aborts the run under
    /// `continueAfterFailure = false`. The identifier is the contract.
    @discardableResult
    func openTradeDetail(in app: XCUIApplication) -> XCUIElement {
        let detailTitle = app.staticTexts["Trade Details"]
        let row = app.descendants(matching: .any)
            .matching(identifier: "trades.row").firstMatch

        XCTAssertTrue(
            row.waitForExistence(timeout: UITestTimeout.scene),
            "No element with identifier 'trades.row' on the Trades tab. Either the live "
            + "feed returned no rows, or TradeCard lost its .accessibilityIdentifier."
        )

        row.tap()
        XCTAssertTrue(
            detailTitle.waitForExistence(timeout: UITestTimeout.presentation),
            "Tapped a 'trades.row' element but the trade detail sheet never appeared."
        )
        return detailTitle
    }

    /// Swipes any presented sheet away and waits for it to actually leave.
    func dismissAnyPresentedSheet(in app: XCUIApplication) {
        guard app.sheets.firstMatch.exists || app.navigationBars.count > 1 else { return }
        app.swipeDown(velocity: .fast)
        _ = app.staticTexts["Trade Details"].waitForNonExistence(timeout: UITestTimeout.presentation)
    }

    /// Captures the whole screen (status bar included) and attaches it so the
    /// driving script can harvest it out of the .xcresult bundle.
    ///
    /// `XCUIScreen.main.screenshot()` returns the device's native pixel
    /// resolution — 1320x2868 on a 6.9" iPhone — which is exactly what App
    /// Store Connect wants, so nothing is scaled here.
    func captureScreen(named name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Convenience: `01_trends`, `02_trades`, …
    func captureScene(_ scene: AppScene) {
        captureScreen(named: String(format: "%02d_%@", scene.captureIndex, scene.rawValue))
    }
}
