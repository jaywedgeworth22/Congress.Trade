import XCTest

/// Smoke coverage for the shipped iOS app, driven entirely through the
/// accessibility API. These run against **live production data**, so they
/// assert that each scene reaches real content — not that it contains any
/// particular row, which would make the suite fail every time Congress files
/// something new.
final class CongressTradeUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Every tab loads real content within its timeout. This is the test that
    /// catches "the app launches but tab N is stuck on a spinner", which is
    /// exactly the state that would otherwise be captured into a store slot.
    func testAllTabsLoadContent() throws {
        let app = XCUIApplication.launchForUITests()
        waitForAppReady(app)

        for scene in AppScene.allCases {
            selectTab(scene, in: app)
            waitForSceneContent(scene, in: app)
        }
    }

    /// A trade row opens the trade detail sheet.
    func testTradeRowOpensDetail() throws {
        let app = XCUIApplication.launchForUITests()
        waitForAppReady(app)

        selectTab(.trades, in: app)
        waitForSceneContent(.trades, in: app)

        let detail = openTradeDetail(in: app)
        XCTAssertTrue(detail.exists, "Trade detail sheet did not stay presented.")
    }

    /// The header quick menu opens. `HamburgerMenuButton` already carries
    /// `.accessibilityLabel("Menu")` on main, so this needs no app-side change.
    func testHeaderQuickMenuOpens() throws {
        let app = XCUIApplication.launchForUITests()
        waitForAppReady(app)

        selectTab(.trades, in: app)
        waitForSceneContent(.trades, in: app)

        let menuButton = app.buttons["Menu"].firstMatch
        XCTAssertTrue(
            menuButton.waitForExistence(timeout: UITestTimeout.presentation),
            "Header hamburger button ('Menu') is missing from the Trades toolbar."
        )
        menuButton.tap()

        // AccountQuickMenu always renders a "Theme" section header, signed in
        // or out, which makes it the stable proof the popover actually opened.
        XCTAssertTrue(
            app.staticTexts["Theme"].waitForExistence(timeout: UITestTimeout.presentation),
            "Account quick menu did not open — no 'Theme' section appeared."
        )
    }
}
