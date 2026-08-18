# iOS Admin views

These screens compile from files already in the Xcode target so this PR does not edit `project.pbxproj`:

- `Views/Status/SettingsView.swift` — `AdminPanelView`, `ReviewQueueView`, `ReviewDetailView`, `AdminTokenField`
- `Views/Components/Components.swift` — hamburger `Admin` row + `navigationDestination`
- `Models.swift`, `APIClient.swift`, `KeychainTokenStore.swift`, `Store/CongressTradeStore.swift`

A Mac/Xcode pass can move the Admin UI types into this folder and add the new files to the `CongressTrade` target.  Do not add duplicates while the types still live in `SettingsView.swift`.
