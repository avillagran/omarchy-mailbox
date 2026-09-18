// Mailbox — Gmail and HEY inbox counter for Omarchy.
// Reads local browser-bridge snapshots and desktop email notifications.
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

BarWidget {
  id: root
  moduleName: "io.github.avillagran.omarchy-mailbox"

  property int totalUnread: 0
  property var accounts: []
  property var emails: []
  property int rotationIndex: 0
  readonly property var readableAccounts: {
    var live = root.accounts.filter(function(account) { return account.unavailable !== true })
    return live.length ? live : root.accounts
  }
  readonly property var displayedAccount: root.readableAccounts.length ? root.readableAccounts[root.rotationIndex % root.readableAccounts.length] : null
  Timer {
    interval: 6000
    repeat: true
    running: root.readableAccounts.length > 1
    onTriggered: root.rotationIndex = (root.rotationIndex + 1) % root.readableAccounts.length
  }
  onAccountsChanged: { var available = root.readableAccounts || []; if (root.rotationIndex >= available.length) root.rotationIndex = 0 }
  property var sourceInfo: ({})
  property string fetchStatus: "loading"
  property string fetchMessage: ""
  property bool syncing: false
  property var i18nCatalog: ({})
  property string language: "en"
  property var msgids: ({"invalidResponse":"Mailbox received an invalid response.","syncingTabs":"Synchronizing open Gmail tabs…","accountUnreadTooltip":"%1 · %2 unread","gmailUnreadInbox":"Gmail unread Inbox","bodyTooLarge":"Message content is too large to cache. Open it in Gmail.","bodyNotCached":"Message content is not cached. Open it in Gmail or enable downloads in settings.","requestingAuthorization":"Requesting browser installation authorization…","installFailed":"Install failed: %1","updateInstalledRestart":"Extension installed. Restart the browser to finish.","installCancelled":"Install failed or was cancelled: %1","browserRestarted":"Browser restarted · synchronizing Gmail…","restartFailed":"Restart failed: %1","removalReadyRestart":"Extension removal is ready · restart the browser","pluginUpdated":"Extension %1 is active","updateReadyRestart":"Update %1 ready · restart the browser (active %2)","none":"none","updateAvailable":"Update available: %1 → %2","extensionNotInstalled":"Extension not installed","extensionCheckFailed":"Could not check the extension","uninstallFailed":"Uninstall failed: %1","removalPreparedRestart":"Extension removal prepared. Restart the browser to finish.","uninstallCancelled":"Uninstall failed or was cancelled.","saved":"Saved","settingsSaveFailed":"Could not save settings.","shortcutSaveFailed":"Could not save shortcut.","shortcutSaved":"Saved · SUPER+SHIFT+%1","shortcutFailed":"Shortcut failed: %1","installingBridge":"Installing Mailbox Local Bridge…","removingBridge":"Removing Mailbox Local Bridge…","restartingBrowser":"Restarting browser…","checkingExtension":"Checking extension…","saving":"Saving…","clearingBodies":"Clearing downloaded content…","useOneLetter":"Use one letter from A to Z.","unreadAll":"%1 unread in all Inboxes","unreadInbox":"%1 unread in Inbox","markAsRead":"Mark as read","connect":"Connect","accountBadges":"Account badges","themeColorsHint":"Choose among 9 live Omarchy theme colors: Accent plus the theme’s basic Red, Yellow, Orange, Green, Cyan, Blue, Magenta, and Brown.","inboxSource":"Inbox source: %1 · profile %2","unknown":"unknown","defaultProfile":"Default","installBridgeHint":"Install Mailbox Local Bridge in the default browser. It reads only open Gmail tabs locally. Restart that browser once after installing.","installInBrowser":"Install in browser","restartBrowser":"Restart browser","restartBrowserHint":"Restart the default browser after installing or updating Mailbox Local Bridge.","openClosePanel":"Open/close panel","storedMessagesPerAccount":"Stored messages per account","downloadEmailContent":"Download email content","downloadEmailContentHint":"Store email content locally so messages can be expanded in the panel.","clearDownloadedContent":"Clear downloaded content","gmailNotConnected":"Gmail is not connected for this account. Open its Inbox to connect it.","installBridge":"Install bridge","openGmail":"Open Gmail","openInbox":"Open Inbox","noSubject":"(no subject)"})
  function t(key) { var msgid = root.msgids[key] || key; var selected = root.i18nCatalog[root.language] || {}; return selected[msgid] !== undefined ? selected[msgid] : msgid }
  function tf(key, values) { var result = root.t(key); for (var i = 0; i < values.length; i++) result = result.replace("%" + (i + 1), values[i]); return result }
  FileView { path: Qt.resolvedUrl("i18n.json").toString().replace("file://", ""); printErrors: true; onLoaded: { try { root.i18nCatalog = JSON.parse(text()) } catch (_) { root.i18nCatalog = ({}) } } }
  Process {
    id: localeProc
    command: ["localectl", "status"]
    running: false
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: function() { var match = text.match(/LANG=([A-Za-z]+)/); var locale = match ? match[1] : Qt.locale().name; root.language = String(locale || "en").split(/[_.-]/)[0].toLowerCase() } }
  }
  property var themePalette: ({})
  FileView { id: barThemeColors; path: Color.currentThemePath + "/colors.toml"; watchChanges: true; printErrors: false; onLoaded: root.loadThemePalette(text()); onFileChanged: reload() }
  Connections {
    target: Color
    function onShellValuesChanged() { barThemeColors.reload() }
  }
  property string binPath: Qt.resolvedUrl("bin/mailbox.js").toString().replace("file://", "")

  function loadThemePalette(raw) { var palette = {}; var lines = String(raw || "").split("\n"); for (var i = 0; i < lines.length; i++) { var match = lines[i].match(/^\s*(red|yellow|orange|green|cyan|blue|magenta|brown)\s*=\s*["']?(#[0-9A-Fa-f]{6})/); if (match) palette[match[1]] = match[2]; } root.themePalette = palette }
  function badgeColor(role) {
    if (root.themePalette[role]) return Color.flatColor(root.themePalette[role], Color.accent)
    if (role === "urgent") return Color.urgent
    if (role === "foreground") return Color.foreground
    if (role === "muted") return Color.muted
    return Color.accent
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function togglePanel() { root.toggle() }
  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("i18nCatalog" in target) target.i18nCatalog = root.i18nCatalog
    if ("language" in target) target.language = root.language
    if ("msgids" in target) target.msgids = root.msgids
  }
  onBarChanged: injectPanel()
  onI18nCatalogChanged: injectPanel()
  onLanguageChanged: injectPanel()

  IpcHandler {
    target: root.moduleName
    function open(): void { root.broadcast("open") }
    function close(): void { root.broadcast("close") }
    function toggle(): void { root.broadcast("toggle") }
  }

  // --- polling (user-configurable, default 5 min) ---
  // Cache/bridge reads are local; poll frequently to surface desktop email
  // notifications even while every supported mail tab is closed.
  property int pollInterval: 15000
  Timer {
    id: pollTimer
    interval: root.pollInterval
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  // --- scan ---
  property bool forceRefresh: false
  property bool refreshQueued: false
  Process {
    id: scanProc
    command: root.forceRefresh ? ["node", root.binPath, "--refresh"] : ["node", root.binPath]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: function() {
        root.parseResult(text)
        if (root.refreshQueued) {
          root.refreshQueued = false
          Qt.callLater(function() { root.refresh(false) })
        }
      }
    }
  }

  function parseResult(text) {
    try {
      var data = JSON.parse(text)
      root.accounts = data.accounts || []
      root.emails = data.emails || []
      root.sourceInfo = data.source || ({})
      root.fetchStatus = data.status || "ok"
      root.fetchMessage = data.message || ""
      root.syncing = false
      var total = 0
      for (var i = 0; i < root.accounts.length; i++)
        if (root.accounts[i].unread > 0) total += root.accounts[i].unread
      root.totalUnread = total
      root.forceRefresh = false
      root.panelData(panelLoader.item ? panelLoader.item.settingsMode : false)
    } catch(e) {
      root.accounts = []
      root.emails = []
      root.totalUnread = 0
      root.fetchStatus = "unavailable"
      root.syncing = false
      root.fetchMessage = root.t("invalidResponse")
    }
  }

  function refresh(force) {
    if (scanProc.running) {
      root.refreshQueued = true
      return
    }
    root.forceRefresh = force === true
    root.syncing = true
    root.fetchStatus = "syncing"
    root.fetchMessage = root.t("syncingTabs")
    root.panelData(panelLoader.item ? panelLoader.item.settingsMode : false)
    scanProc.running = true
  }
  function openGmail() { Quickshell.execDetached(["xdg-open", "https://mail.google.com"]) }

  // --- panel loader (correct pattern: Loader + Panel.qml) ---
  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
      item.emails = root.emails
      item.accounts = root.accounts
      item.sourceInfo = root.sourceInfo
      item.totalUnread = root.totalUnread
      item.fetchStatus = root.fetchStatus
      item.fetchMessage = root.fetchMessage
      item.syncing = root.syncing
      item.i18nCatalog = root.i18nCatalog
      item.language = root.language
      item.msgids = root.msgids
    }
  }

  function panelData(settings) {
    if (!panelLoader.item) return
    panelLoader.item.emails = root.emails
    panelLoader.item.accounts = root.accounts
    panelLoader.item.sourceInfo = root.sourceInfo
    panelLoader.item.settingsMode = settings
    panelLoader.item.totalUnread = root.totalUnread
    panelLoader.item.fetchStatus = root.fetchStatus
    panelLoader.item.fetchMessage = root.fetchMessage
    panelLoader.item.syncing = root.syncing
    panelLoader.item.i18nCatalog = root.i18nCatalog
    panelLoader.item.language = root.language
    panelLoader.item.msgids = root.msgids
  }
  function label() {
    if (!root.displayedAccount) return "󰊫 0"
    var count = root.displayedAccount.unread > 99 ? "99+" : String(root.displayedAccount.unread)
    return "󰊫 " + (root.displayedAccount.initials || "?") + " " + count
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // WidgetButton registers itself with the bar click router. A free MouseArea
  // in a BarWidget can be painted but never receive events on this shell.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.label()
    fontSize: Style.font.caption
    fontFamily: Style.font.family
    foreground: root.displayedAccount ? root.badgeColor(root.displayedAccount.color) : Color.foreground
    activeColor: root.displayedAccount ? root.badgeColor(root.displayedAccount.color) : Color.accent
    active: root.totalUnread > 0
    tooltipText: root.displayedAccount ? root.tf("accountUnreadTooltip", [root.displayedAccount.email, root.displayedAccount.unread]) : root.t("gmailUnreadInbox")
    onPressed: function(buttonPressed) {
      if (buttonPressed === Qt.LeftButton) {
        root.panelData(false)
        root.togglePanel()
      } else if (buttonPressed === Qt.RightButton) {
        root.panelData(true)
        panelLoader.item.showSettings()
      }
    }
  }

  Component.onCompleted: { localeProc.running = true; root.refresh() }
}
