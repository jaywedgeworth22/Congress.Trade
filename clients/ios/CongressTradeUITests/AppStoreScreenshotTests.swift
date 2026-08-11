import XCTest

/// Drives the app through every App Store scene and attaches a full-screen,
/// native-resolution screenshot of each.
///
/// Harvesting: the attachments come out of the .xcresult bundle with
/// `xcrun xcresulttool export attachments`, which is what
/// `scripts/capture-app-store-screenshots.sh` does. That was chosen over having
/// a shell script poll `xcrun simctl io <udid> screenshot` while the test
/// pauses, because the attachment path needs no cross-process synchronisation:
/// the capture happens on the exact frame the test judged the scene ready, so a
/// slow network can never race the shutter. The `manifest.json` that
/// `export attachments` writes maps each PNG back to the name set here, which
/// makes renaming on harvest trivial.
///
/// Run alone with:
///   -only-testing:CongressTradeUITests/AppStoreScreenshotTests
final class AppStoreScreenshotTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// One launch, every scene: cheaper than relaunching per scene, and it
    /// keeps the live data identical across the whole set, so the shots read as
    /// one coherent session rather than six different refreshes.
    func testCaptureAppStoreScenes() throws {
        let app = XCUIApplication.launchForUITests()
        waitForAppReady(app)

        // Trades first: it is the tab whose content proves the live feed
        // actually returned rows. If it is empty the whole run is worthless, so
        // fail here rather than after capturing five good scenes.
        selectTab(.trades, in: app)
        waitForSceneContent(.trades, in: app)

        // Walk the tabs in listing order and capture each.
        for scene in AppScene.allCases {
            selectTab(scene, in: app)
            waitForSceneContent(scene, in: app)
            captureScene(scene)
        }

        // Trade detail sheet (scene 6), captured at its default .medium detent
        // so the trades list stays visible behind it — the same framing as the
        // previously shipped set in docs/brand/app-store-screenshots/archive.
        selectTab(.trades, in: app)
        waitForSceneContent(.trades, in: app)
        let detail = openTradeDetail(in: app)
        XCTAssertTrue(
            detail.waitForExistence(timeout: UITestTimeout.presentation),
            "Trade detail sheet vanished before it could be captured."
        )
        // The sheet's own content settling is the shutter cue, not a sleep.
        waitForSceneContent(.trades, in: app, timeout: UITestTimeout.presentation)
        captureScreen(named: "06_trade_detail")

        dismissAnyPresentedSheet(in: app)

        // Header quick menu (scene 7). `HamburgerMenuButton` already exposes
        // .accessibilityLabel("Menu") on main, so no app change is needed.
        let menuButton = app.buttons["Menu"].firstMatch
        XCTAssertTrue(
            menuButton.waitForExistence(timeout: UITestTimeout.presentation),
            "Header hamburger button is missing — cannot capture scene 07."
        )
        menuButton.tap()
        XCTAssertTrue(
            app.staticTexts["Theme"].waitForExistence(timeout: UITestTimeout.presentation),
            "Account quick menu did not open — cannot capture scene 07."
        )
        waitForSceneContent(.trades, in: app, timeout: UITestTimeout.presentation)
        captureScreen(named: "07_quick_menu")
    }
}
