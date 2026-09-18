// Mailbox Panel — Gmail and HEY unread Inbox popup.
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

Panel {
  id: root
  moduleName: "io.github.avillagran.omarchy-mailbox"
  ipcTarget: "io.github.avillagran.omarchy-mailbox"
  manageIpc: false

  property var emails: []
  property var accounts: []
  property var sourceInfo: ({})
  property int totalUnread: 0
  property string fetchStatus: "loading"
  property string fetchMessage: ""
  property bool syncing: false
  property var themePalette: ({})
  FileView {
    id: panelThemeColors
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.loadThemePalette(text())
    onFileChanged: reload()
  }
  Connections {
    target: Color
    function onShellValuesChanged() { panelThemeColors.reload() }
  }
  property string binPath: Qt.resolvedUrl("bin/mailbox.js").toString().replace("file://", "")
  property string settingsBin: Qt.resolvedUrl("bin/mailbox-settings.js").toString().replace("file://", "")
  property string bridgeInstallBin: Qt.resolvedUrl("bin/mailbox-bridge-install.js").toString().replace("file://", "")
  property string bridgeSystemInstallBin: Qt.resolvedUrl("bin/mailbox-bridge-system-install.sh").toString().replace("file://", "")
  property string browserRestartBin: Qt.resolvedUrl("bin/mailbox-browser-restart.py").toString().replace("file://", "")
  property string forceRefreshBin: Qt.resolvedUrl("bin/mailbox-force-refresh.js").toString().replace("file://", "")
  property string browserRestartState: ""
  property string bridgeInstallState: ""
  property string bridgeStatusText: ""
  property bool bridgeUpToDate: false
  property bool bridgeInstalled: false
  property bool bridgeStatusKnown: false
  property string bridgeStatusBin: Qt.resolvedUrl("bin/mailbox-bridge-status.js").toString().replace("file://", "")
  property string keybindBin: Qt.resolvedUrl("bin/mailbox-keybind.js").toString().replace("file://", "")
  property string shortcutKey: "Q"
  property string shortcutState: ""
  property int maxMessagesPerAccount: 50
  property bool downloadBodies: true
  property string bodySettingsState: ""
  property var i18nCatalog: ({})
  property string language: "en"
  property var msgids: ({})
  property var pendingBadgeSave: null
  property var activeBadgeSave: null
  property string bridgePendingBin: Qt.resolvedUrl("bin/mailbox-bridge-pending.js").toString().replace("file://", "")
  property bool settingsMode: false
  property string selectedAccount: "__all__"
  property int selectedEmailIndex: 0
  property int expandedEmailIndex: -1
  property bool returnTriggered: false
  function selectedEmail() { var rows = root.filteredEmails(); return rows.length && root.selectedEmailIndex >= 0 ? rows[root.selectedEmailIndex] : null }
  function t(key) { var msgid = root.msgids[key] || key; var selected = root.i18nCatalog[root.language] || {}; return selected[msgid] !== undefined ? selected[msgid] : msgid }
  function tf(key, values) { var result = root.t(key); for (var i = 0; i < values.length; i++) result = result.replace("%" + (i + 1), values[i]); return result }
  function moveEmail(delta) { var rows = root.filteredEmails(); if (!rows.length) return; root.selectedEmailIndex = Math.max(0, Math.min(rows.length - 1, root.selectedEmailIndex + delta)); Qt.callLater(root.ensureSelectedEmailVisible) }
  function toggleSelectedEmail() { var email = root.selectedEmail(); if (!email || email.notification) return; root.expandedEmailIndex = root.expandedEmailIndex === root.selectedEmailIndex ? -1 : root.selectedEmailIndex; Qt.callLater(root.ensureSelectedEmailVisible) }
  function openSelectedEmail() { var email = root.selectedEmail(); if (email) root.openEmail(email) }
  function selectedUnread() {
    if (root.selectedAccount === "__all__") return root.totalUnread
    for (var i = 0; i < root.accounts.length; i++) if (root.accounts[i].email === root.selectedAccount) return root.accounts[i].unread
    return 0
  }
  function filteredEmails() {
    if (root.selectedAccount === "__all__") return root.emails
    return root.emails.filter(function(email) { return email.account === root.selectedAccount })
  }
  function ensureSelectedEmailVisible() {
    var rows = root.filteredEmails()
    if (!rows.length) { root.selectedEmailIndex = 0; return }
    root.selectedEmailIndex = Math.max(0, Math.min(rows.length - 1, root.selectedEmailIndex))
    var item = emailRepeater.itemAt(root.selectedEmailIndex)
    if (!item || !item.visible) return
    var top = item.y
    var bottom = top + item.height
    var target = scroll.contentY
    if (top < target) target = top
    else if (bottom > target + scroll.height) target = bottom - scroll.height
    scroll.contentY = Math.max(0, Math.min(target, Math.max(0, scroll.contentHeight - scroll.height)))
  }
  function emailBodyText(email) {
    var parts = email && email.body && email.body.messages ? email.body.messages : []
    var content = []
    for (var i = 0; i < parts.length; i++) if (parts[i].text) content.push((parts[i].from ? parts[i].from + (parts[i].date ? " · " + parts[i].date : "") + "\n" : "") + parts[i].text)
    if (content.length) return content.join("\n\n────────────────\n\n")
    if (email && email.bodyState === "too-large") return root.t("bodyTooLarge")
    return String(email && email.snippet || "") + "\n\n" + root.t("bodyNotCached")
  }
  function accountFor(email) {
    for (var i = 0; i < root.accounts.length; i++) if (root.accounts[i].email === email) return root.accounts[i]
    return null
  }
  // These are injected by BarWidget after the bar is assigned asynchronously.
  // Without them KeyboardPanel cannot anchor its layer-shell surface.
  property var bar: null
  property var anchorItem: null
  property var hostWidget: null
  // The bar coordinates popouts by its BarWidget instance, never this nested
  // panel. Using the panel creates stale ownership and intermittent mapping.
  readonly property var barIdentity: hostWidget || root

  Timer {
    id: pollTimer
    interval: 300000
    repeat: true
    running: root.opened
    onTriggered: root.refresh()
  }

  Process {
    id: fetchProc
    command: ["node", root.binPath]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseResult(text)
    }
  }

  Process {
    id: bridgeInstallProc
    command: ["node", root.bridgeInstallBin]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { root.bridgeInstallState = root.t("requestingAuthorization"); systemBridgeInstallProc.running = true }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { if (text.trim().length) root.bridgeInstallState = root.tf("installFailed", [text.trim()]) }
    }
  }

  Process {
    id: systemBridgeInstallProc
    command: ["pkexec", root.bridgeSystemInstallBin]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: function() {
        root.bridgeInstallState = root.t("updateInstalledRestart")
        bridgeStatusRetry.restart()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { if (text.trim().length) root.bridgeInstallState = root.tf("installCancelled", [text.trim()]) }
    }
  }

  Process {
    id: browserRestartProc
    command: ["python3", root.browserRestartBin]
    running: false
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: function() { root.browserRestartState = root.t("browserRestarted"); root.syncing = true; bridgeStatusRetry.restart() } }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: { if (text.trim().length) root.browserRestartState = root.tf("restartFailed", [text.trim()]) } }
  }

  Process {
    id: bridgeStatusProc
    command: ["node", root.bridgeStatusBin]
    running: false
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: function() { try { var status = JSON.parse(text); root.bridgeInstalled = status.installed === true; root.bridgeUpToDate = status.upToDate === true; root.bridgeStatusKnown = true; root.bridgeStatusText = status.removalReady ? root.t("removalReadyRestart") : (root.bridgeUpToDate ? root.tf("pluginUpdated", [status.loadedVersion]) : (status.updateReady ? root.tf("updateReadyRestart", [status.stagedVersion || status.registeredVersion, status.loadedVersion || root.t("none")]) : (status.installed ? root.tf("updateAvailable", [status.loadedVersion || status.registeredVersion, status.latestVersion]) : root.t("extensionNotInstalled")))) } catch (_) { root.bridgeInstalled = false; root.bridgeStatusKnown = true; root.bridgeStatusText = root.t("extensionCheckFailed") } } }
  }

  Timer { id: bridgeStatusRetry; interval: 3500; repeat: false; onTriggered: { if (!bridgeStatusProc.running) bridgeStatusProc.running = true } }

  Process {
    id: badgeSaveProc
    running: false
    onExited: function() { root.finishBadgeSave() }
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: function() { if (text.trim().length) console.warn("Mailbox badge save failed: " + text.trim()) } }
  }

  Process {
    id: bridgeUninstallProc
    command: ["node", root.bridgeInstallBin, "--uninstall"]
    running: false
    onExited: function(exitCode) { if (exitCode === 0) systemBridgeUninstallProc.running = true }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: function() { if (text.trim().length) root.bridgeInstallState = root.tf("uninstallFailed", [text.trim()]) } }
  }

  Process {
    id: systemBridgeUninstallProc
    command: ["pkexec", root.bridgeSystemInstallBin, "--uninstall"]
    running: false
    onExited: function(exitCode) { root.bridgeInstallState = exitCode === 0 ? root.t("removalPreparedRestart") : root.t("uninstallCancelled"); bridgeStatusRetry.restart() }
  }

  Process {
    id: shortcutLoadProc
    command: ["node", root.settingsBin, "get"]
    running: false
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: function() { try { var value = JSON.parse(text); root.shortcutKey = value.shortcutKey || "Q"; root.maxMessagesPerAccount = value.maxMessagesPerAccount || 50; root.downloadBodies = value.downloadBodies !== false } catch (_) {} } }
  }

  Process {
    id: bodySettingsProc
    running: false
    onExited: function(exitCode) { root.bodySettingsState = exitCode === 0 ? root.t("saved") : root.t("settingsSaveFailed"); if (root.hostWidget) root.hostWidget.refresh(false) }
  }

  Process {
    id: shortcutSaveProc
    running: false
    onExited: function(exitCode) { if (exitCode === 0) { keybindProc.command = ["node", root.keybindBin, root.shortcutKey]; keybindProc.running = true } else root.shortcutState = root.t("shortcutSaveFailed") }
  }

  Process {
    id: keybindProc
    running: false
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: function() { root.shortcutState = root.tf("shortcutSaved", [root.shortcutKey]) } }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: function() { if (text.trim().length) root.shortcutState = root.tf("shortcutFailed", [text.trim()]) } }
  }

  function parseResult(text) {
    try {
      var data = JSON.parse(text)
      root.emails = data.emails || []
      root.accounts = data.accounts || root.accounts
      root.sourceInfo = data.source || root.sourceInfo
      root.totalUnread = data.total || 0
      root.fetchStatus = data.status || "ok"
      root.fetchMessage = data.message || ""
      root.selectedEmailIndex = Math.max(0, Math.min(root.selectedEmailIndex, Math.max(0, root.filteredEmails().length - 1)))
      Qt.callLater(root.ensureSelectedEmailVisible)
    } catch (e) {
      root.emails = []
      root.totalUnread = 0
      root.fetchStatus = "unavailable"
      root.fetchMessage = root.t("invalidResponse")
    }
  }

  function refresh(forceExtensionCapture) {
    root.syncing = true
    if (forceExtensionCapture === true && root.settingsMode) Quickshell.execDetached(["node", root.forceRefreshBin])
    if (root.hostWidget) root.hostWidget.refresh(true)
  }
  function openAccountInbox(account) {
    if (!account) return
    if (account.inboxUrl) { Quickshell.execDetached(["xdg-open", account.inboxUrl]); return }
    Quickshell.execDetached(["node", root.bridgePendingBin, account.email])
    Quickshell.execDetached(["xdg-open", "https://mail.google.com/mail/?authuser=" + encodeURIComponent(account.email) + "#inbox"])
  }
  function openInbox() {
    var account = root.accountFor(root.selectedAccount)
    if (account && account.unavailable) {
      root.openAccountInbox(account)
      return
    }
    if (account && account.inboxUrl) { Quickshell.execDetached(["xdg-open", account.inboxUrl]); return }
    var index = account ? account.index : 0
    Quickshell.execDetached(["xdg-open", "https://mail.google.com/mail/u/" + index + "/#inbox"])
  }
  function gmailMessageUrl(email) {
    var direct = String(email && email.url || "")
    if (email && email.notification && /^https:\/\/(?:mail\.google\.com|app\.hey\.com)\//.test(direct)) return direct
    if (/^https:\/\/mail\.google\.com\/mail\/u\/\d+\/#(?:inbox|all|starred|important|sent|trash|spam|label\/[^/]+)\/[^/?#]+/.test(direct)) return direct
    if (/^https:\/\/app\.hey\.com\/topics\/\d+/.test(direct)) return direct
    var account = root.accountFor(email.account)
    if (account && account.provider === "hey") {
      var heyThread = String(email.threadId || "").replace(/[^0-9]/g, "")
      return heyThread ? "https://app.hey.com/topics/" + heyThread : ""
    }
    var index = account && account.index !== null && account.index !== undefined ? account.index : 0
    var thread = String(email.threadId || "").replace(/^#/, "")
    return thread ? "https://mail.google.com/mail/u/" + index + "/#inbox/" + thread : ""
  }
  function openEmail(email) {
    var sourceAccount = root.accountFor(email.account)
    if (sourceAccount && sourceAccount.unavailable === true && !email.url && !email.threadId) {
      root.selectedAccount = sourceAccount.email
      root.reconnectSelectedAccount()
      return
    }
    var direct = root.gmailMessageUrl(email)
    if (direct.length) {
      Quickshell.execDetached(["xdg-open", direct])
      return
    }
    root.openAccountInbox(sourceAccount)
  }
  function reconnectSelectedAccount() {
    var account = root.accountFor(root.selectedAccount)
    root.openAccountInbox(account)
  }
  function installBridge() { if (!bridgeInstallProc.running) { root.bridgeInstallState = root.t("installingBridge"); bridgeInstallProc.running = true } }
  function uninstallBridge() { if (!bridgeUninstallProc.running && !systemBridgeUninstallProc.running) { root.bridgeInstallState = root.t("removingBridge"); bridgeUninstallProc.running = true } }
  function restartBrowser() { if (!browserRestartProc.running) { root.browserRestartState = root.t("restartingBrowser"); browserRestartProc.running = true } }
  function checkBridgeStatus() { if (!bridgeStatusProc.running) { root.bridgeStatusKnown = false; root.bridgeStatusText = root.t("checkingExtension"); bridgeStatusProc.running = true } }
  function showSettings() { root.settingsMode = true; root.checkBridgeStatus(); if (!shortcutLoadProc.running) shortcutLoadProc.running = true; if (!root.opened) root.open() }
  function showInbox() { root.settingsMode = false; root.selectedEmailIndex = Math.max(0, Math.min(root.selectedEmailIndex, Math.max(0, root.filteredEmails().length - 1))); Qt.callLater(function() { keyCatcher.forceActiveFocus(); root.ensureSelectedEmailVisible() }) }
  function cycleAccount(direction) {
    var tabs = ["__all__"]
    for (var i = 0; i < root.accounts.length; i++) tabs.push(root.accounts[i].email)
    var current = tabs.indexOf(root.selectedAccount)
    if (current < 0) current = 0
    root.selectedAccount = tabs[(current + direction + tabs.length) % tabs.length]
    root.selectedEmailIndex = 0
    root.expandedEmailIndex = -1
    Qt.callLater(root.ensureSelectedEmailVisible)
  }
  function setDownloadBodies(enabled) { root.downloadBodies = enabled; root.bodySettingsState = root.t("saving"); bodySettingsProc.command = ["node", root.settingsBin, "set-download-bodies", enabled ? "true" : "false"]; bodySettingsProc.running = true }
  function clearBodies() { root.bodySettingsState = root.t("clearingBodies"); bodySettingsProc.command = ["node", root.settingsBin, "clear-bodies"]; bodySettingsProc.running = true }
  function saveShortcut(value) {
    var key = String(value || "").trim().toUpperCase()
    if (!/^[A-Z]$/.test(key)) { root.shortcutState = root.t("useOneLetter"); return }
    root.shortcutKey = key
    root.shortcutState = root.t("saving")
    shortcutSaveProc.command = ["node", root.settingsBin, "set-shortcut", key]
    shortcutSaveProc.running = true
  }
  function loadThemePalette(raw) {
    var palette = {}
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(/^\s*(red|yellow|orange|green|cyan|blue|magenta|brown)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
      if (match) palette[match[1]] = match[2]
    }
    root.themePalette = palette
  }
  function badgeColor(role) {
    if (root.themePalette[role]) return Color.flatColor(root.themePalette[role], Color.accent)
    if (role === "urgent") return Color.urgent
    if (role === "foreground") return Color.foreground
    if (role === "muted") return Color.muted
    return Color.accent
  }
  function applyBadgeLocally(email, normalized, color) {
    var copy = root.accounts.slice(0)
    for (var i = 0; i < copy.length; i++) {
      if (copy[i].email === email) copy[i] = Object.assign({}, copy[i], { initials: normalized, color: color })
    }
    root.accounts = copy
    var emailCopy = root.emails.slice(0)
    for (var k = 0; k < emailCopy.length; k++) {
      if (emailCopy[k].account === email) emailCopy[k] = Object.assign({}, emailCopy[k], { initials: normalized, color: color })
    }
    root.emails = emailCopy
    if (root.hostWidget) {
      var hostCopy = root.hostWidget.accounts.slice(0)
      for (var j = 0; j < hostCopy.length; j++) {
        if (hostCopy[j].email === email) hostCopy[j] = Object.assign({}, hostCopy[j], { initials: normalized, color: color })
      }
      root.hostWidget.accounts = hostCopy
      var hostEmails = root.hostWidget.emails.slice(0)
      for (var h = 0; h < hostEmails.length; h++) {
        if (hostEmails[h].account === email) hostEmails[h] = Object.assign({}, hostEmails[h], { initials: normalized, color: color })
      }
      root.hostWidget.emails = hostEmails
    }
  }
  function startBadgeSave() {
    if (badgeSaveProc.running || !root.pendingBadgeSave) return
    root.activeBadgeSave = root.pendingBadgeSave
    root.pendingBadgeSave = null
    badgeSaveProc.command = ["node", root.settingsBin, "set", root.activeBadgeSave.email, root.activeBadgeSave.initials, root.activeBadgeSave.color]
    badgeSaveProc.running = true
  }
  function finishBadgeSave() {
    root.activeBadgeSave = null
    if (root.pendingBadgeSave) root.startBadgeSave()
    else if (root.hostWidget) root.hostWidget.refresh(false)
  }
  function saveBadge(email, initials, color) {
    var normalized = String(initials || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3)
    if (!normalized) return
    var selectedColor = color || "accent"
    root.applyBadgeLocally(email, normalized, selectedColor)
    root.pendingBadgeSave = { email: email, initials: normalized, color: selectedColor }
    root.startBadgeSave()
  }
  function cycleColor(account) {
    var roles = ["accent", "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown"]
    var next = roles[(roles.indexOf(account.color) + 1) % roles.length]
    root.saveBadge(account.email, account.initials, next)
  }

  PinnedKeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(600))
    contentHeight: panel.fittedContentHeight(scroll.contentHeight + fixedChrome.implicitHeight + Style.space(8), Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onMoveRequested: function(dx, dy) { if (root.settingsMode) { if (dx < 0) root.showInbox(); return } if (dx !== 0) root.cycleAccount(dx); else if (dy !== 0) root.moveEmail(dy) }
      onReturnRequested: { if (!root.settingsMode) { root.returnTriggered = true; root.openSelectedEmail(); Qt.callLater(function() { root.returnTriggered = false }) } }
      onActivateRequested: { if (!root.settingsMode && !root.returnTriggered) root.toggleSelectedEmail() }
      onTabRequested: function(direction) { if (!root.settingsMode) root.cycleAccount(direction) }
      onTextKey: function(text) { if (root.settingsMode && (text.toLowerCase() === "i" || text.toLowerCase() === "h")) root.showInbox(); else if (!root.settingsMode && text === ",") root.showSettings() }

      Column {
        id: fixedChrome
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)
        Row {
          width: parent.width
          spacing: Style.space(8)
          Text {
            text: "󰊫"
            color: Color.accent
            font.family: "monospace"
            font.pixelSize: Style.font.title
            anchors.verticalCenter: parent.verticalCenter
          }
          Text {
            text: root.selectedAccount === "__all__" ? root.tf("unreadAll", [root.selectedUnread()]) : root.tf("unreadInbox", [root.selectedUnread()])
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
            anchors.verticalCenter: parent.verticalCenter
          }
          Button {
            text: root.t("markAsRead")
            bordered: false
            onClicked: { Quickshell.execDetached(["node", root.settingsBin, "mark-local-read"]); root.emails = []; root.accounts = root.accounts.map(function(account) { return Object.assign({}, account, { unread: 0 }) }); root.totalUnread = 0 }
            anchors.verticalCenter: parent.verticalCenter
          }
          Item { width: parent.width - x - Style.space(170); height: 1 }
          Button {
            iconText: "󰑐"
            bordered: false
            onClicked: root.refresh(root.settingsMode)
            anchors.verticalCenter: parent.verticalCenter
          }
          Button {
            iconText: root.settingsMode ? "󰊫" : ""
            bordered: false
            onClicked: {
              if (root.settingsMode) root.showInbox()
              else root.showSettings()
            }
            anchors.verticalCenter: parent.verticalCenter
          }
        }
        PanelSeparator { foreground: Color.popups.text }
        Flickable {
          visible: !root.settingsMode
          width: parent.width
          height: Style.space(32)
          contentWidth: fixedAccountFilters.implicitWidth
          contentHeight: height
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          Row {
            id: fixedAccountFilters
            spacing: Style.space(6)
            Repeater {
              model: [{ email: "__all__", initials: "ALL", unread: root.totalUnread, color: "accent" }].concat(root.accounts)
              Rectangle {
                property var account: modelData
                width: fixedAccountLabel.implicitWidth + Style.space(18)
                height: Style.space(28)
                radius: Style.cornerRadius
                color: root.selectedAccount === account.email ? Qt.rgba(root.badgeColor(account.color).r, root.badgeColor(account.color).g, root.badgeColor(account.color).b, 0.28) : Qt.rgba(root.badgeColor(account.color).r, root.badgeColor(account.color).g, root.badgeColor(account.color).b, 0.14)
                border.width: root.selectedAccount === account.email ? 1 : 0
                border.color: root.badgeColor(account.color)
                Text { id: fixedAccountLabel; anchors.centerIn: parent; text: parent.account.initials + " " + (parent.account.unavailable === true ? root.t("connect") : parent.account.unread); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: root.selectedAccount === parent.account.email }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.selectedAccount = parent.account.email; root.selectedEmailIndex = 0; root.expandedEmailIndex = -1; Qt.callLater(root.ensureSelectedEmailVisible) } }
              }
            }
          }
        }
      }

      Flickable {
        id: scroll
        anchors.top: fixedChrome.bottom
        anchors.topMargin: Style.space(8)
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: scroll.width
          spacing: Style.space(8)

          Rectangle {
            visible: root.syncing
            width: parent.width - Style.space(16)
            height: Style.space(30)
            anchors.horizontalCenter: parent.horizontalCenter
            radius: Style.cornerRadius
            color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
            Row {
              anchors.centerIn: parent
              spacing: Style.space(6)
              Text { id: syncGlyph; text: "󰑐"; color: Color.accent; font.family: Style.font.family; font.pixelSize: Style.font.body; RotationAnimator on rotation { running: root.syncing; from: 0; to: 360; duration: 850; loops: Animation.Infinite } }
              Text { text: root.t("syncingTabs"); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption }
            }
          }

          Column {
            visible: root.settingsMode
            width: parent.width
            spacing: Style.space(8)
            Text {
              text: root.t("accountBadges")
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }
            Text {
              text: root.t("themeColorsHint")
              width: parent.width
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
            Text {
              width: parent.width
              text: root.tf("inboxSource", [root.sourceInfo.browser || root.t("unknown"), root.sourceInfo.profile || root.t("defaultProfile")])
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
            Rectangle {
              width: parent.width
              height: Style.space(30)
              radius: Style.cornerRadius
              color: root.bridgeUpToDate ? Qt.rgba(root.badgeColor("green").r, root.badgeColor("green").g, root.badgeColor("green").b, 0.24) : Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.16)
              border.color: root.bridgeUpToDate ? root.badgeColor("green") : Color.urgent
              Text { anchors.left: parent.left; anchors.right: uninstallBridgeButton.left; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: Style.space(10); anchors.rightMargin: Style.space(6); text: root.bridgeStatusText; color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true; elide: Text.ElideRight }
              Button { id: uninstallBridgeButton; visible: root.bridgeInstalled; anchors.right: parent.right; anchors.rightMargin: Style.space(4); anchors.verticalCenter: parent.verticalCenter; iconText: "󰆴"; bordered: false; onClicked: root.uninstallBridge() }
            }
            Rectangle {
              visible: root.bridgeStatusKnown && !root.bridgeInstalled
              width: parent.width
              height: bridgeInstallRow.implicitHeight + bridgeInstallStatus.implicitHeight + Style.space(20)
              radius: Style.cornerRadius
              color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)
              border.color: Color.accent
              Row {
                id: bridgeInstallRow
                width: parent.width - Style.space(14)
                anchors.top: parent.top
                anchors.topMargin: Style.space(7)
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: Style.space(8)
                Text {
                  width: parent.width - installBrowserBridgeButton.implicitWidth - Style.space(8)
                  text: root.t("installBridgeHint")
                  wrapMode: Text.WordWrap
                  color: Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
                Button {
                  id: installBrowserBridgeButton
                  text: root.t("installInBrowser")
                  onClicked: root.installBridge()
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
              Text {
                id: bridgeInstallStatus
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(7)
                anchors.rightMargin: Style.space(7)
                anchors.top: bridgeInstallRow.bottom
                anchors.topMargin: Style.space(4)
                text: root.bridgeInstallState
                visible: text.length > 0
                wrapMode: Text.WordWrap
                color: text.indexOf("failed:") === 0 ? Color.urgent : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Button { text: root.t("restartBrowser"); onClicked: root.restartBrowser() }
              Text { width: parent.width - Style.space(120); text: root.browserRestartState.length ? root.browserRestartState : root.t("restartBrowserHint"); wrapMode: Text.WordWrap; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Text { text: root.t("openClosePanel"); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
              Text { text: "SUPER+SHIFT+"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
              TextInput {
                id: shortcutKeyInput
                width: Style.space(32); height: Style.space(28)
                text: root.shortcutKey
                maximumLength: 1; selectByMouse: true
                color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.body
                onTextEdited: { if (text.length === 1) root.saveShortcut(text) }
              }
              Text { text: root.shortcutState; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
            }
            Repeater {
              model: root.sourceInfo.known || []
              Text {
                width: parent.width
                text: modelData.browser + " " + modelData.profile + ": " + modelData.emails.join(", ")
                color: Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Text { text: root.t("storedMessagesPerAccount"); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
              TextInput {
                id: messageLimitInput
                width: Style.space(52); height: Style.space(28)
                text: String(root.maxMessagesPerAccount)
                color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.body
                selectByMouse: true; inputMethodHints: Qt.ImhDigitsOnly
                onEditingFinished: { root.maxMessagesPerAccount = Math.max(1, Math.min(Number(text), 200)); Quickshell.execDetached(["node", root.settingsBin, "set-limit", String(root.maxMessagesPerAccount)]); if (root.hostWidget) root.hostWidget.refresh(true) }
              }
              Text { text: "1–200"; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Text { text: root.t("downloadEmailContent"); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
              ToggleSwitch { checked: root.downloadBodies; onToggled: root.setDownloadBodies(!root.downloadBodies) }
              Text { width: parent.width - Style.space(220); text: root.t("downloadEmailContentHint"); wrapMode: Text.WordWrap; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Button { text: root.t("clearDownloadedContent"); onClicked: root.clearBodies() }
              Text { text: root.bodySettingsState; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
            }
            Repeater {
              model: root.accounts
              Row {
                property var account: modelData
                width: parent.width
                spacing: Style.space(8)
                Rectangle {
                  width: Style.space(28)
                  height: Style.space(28)
                  radius: width / 2
                  color: root.badgeColor(parent.account.color)
                  Text { anchors.centerIn: parent; text: parent.parent.account.initials; color: Color.background; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
                }
                TextInput {
                  id: initialsInput
                  width: Style.space(52)
                  height: Style.space(28)
                  text: parent.account.initials
                  color: Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  selectByMouse: true
                  maximumLength: 3
                  onEditingFinished: root.saveBadge(parent.account.email, text, parent.account.color)
                }
                Text { width: Style.space(150); text: parent.account.label || parent.account.email; color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; elide: Text.ElideRight; anchors.verticalCenter: parent.verticalCenter }
                Repeater {
                  model: [{ role: "accent", label: "A" }, { role: "red", label: "R" }, { role: "yellow", label: "Y" }, { role: "orange", label: "O" }, { role: "green", label: "G" }, { role: "cyan", label: "C" }, { role: "blue", label: "B" }, { role: "magenta", label: "M" }, { role: "brown", label: "N" }]
                  Rectangle {
                    width: Style.space(18)
                    height: Style.space(18)
                    radius: width / 2
                    color: root.badgeColor(modelData.role)
                    border.width: modelData.role === parent.account.color ? 2 : 0
                    border.color: Color.popups.text
                    Text { anchors.centerIn: parent; text: modelData.label; color: Color.background; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.saveBadge(parent.parent.account.email, initialsInput.text, modelData.role) }
                  }
                }
              }
            }
          }

          Text {
            visible: root.fetchStatus !== "ok" || root.fetchMessage.length > 0
            width: parent.width - Style.space(16)
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.fetchMessage
            wrapMode: Text.WordWrap
            color: root.fetchStatus === "login-required" || root.fetchStatus === "unavailable" ? Color.urgent : Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          Rectangle {
            property var selectedInfo: root.accountFor(root.selectedAccount)
            visible: !root.settingsMode && selectedInfo && selectedInfo.unavailable === true
            width: parent.width - Style.space(16)
            height: reconnectRow.implicitHeight + Style.space(14)
            anchors.horizontalCenter: parent.horizontalCenter
            radius: Style.cornerRadius
            color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.16)
            border.color: Color.urgent
            Row {
              id: reconnectRow
              width: parent.width - Style.space(14)
              anchors.centerIn: parent
              spacing: Style.space(8)
              Text {
                width: parent.width - reconnectButton.implicitWidth - Style.space(8)
                text: root.t("gmailNotConnected")
                wrapMode: Text.WordWrap
                color: Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                anchors.verticalCenter: parent.verticalCenter
              }
              Button {
                id: reconnectButton
                visible: root.bridgeStatusKnown
                text: root.bridgeInstalled ? root.t("connect") : root.t("installBridge")
                onClicked: root.bridgeInstalled ? root.reconnectSelectedAccount() : root.installBridge()
                anchors.verticalCenter: parent.verticalCenter
              }
            }
          }

          Rectangle {
            visible: root.fetchStatus === "login-required" || root.filteredEmails().length === 0
            width: Style.space(130)
            height: Style.space(32)
            anchors.horizontalCenter: parent.horizontalCenter
            radius: Style.cornerRadius
            color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
            border.color: Color.accent
            Text {
              anchors.centerIn: parent
              text: root.fetchStatus === "login-required" ? root.t("openGmail") : root.t("openInbox")
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: root.openInbox()
            }
          }

          Repeater {
            id: emailRepeater
            model: root.filteredEmails()
            Rectangle {
              visible: !root.settingsMode
              width: contentColumn.width
              height: emailColumn.implicitHeight + Style.space(14)
              color: root.selectedEmailIndex === index ? Qt.rgba(root.badgeColor(modelData.color).r, root.badgeColor(modelData.color).g, root.badgeColor(modelData.color).b, 0.28) : Qt.rgba(root.badgeColor(modelData.color).r, root.badgeColor(modelData.color).g, root.badgeColor(modelData.color).b, 0.16)
              border.width: root.selectedEmailIndex === index ? 1 : 0
              border.color: root.badgeColor(modelData.color)
              radius: Style.cornerRadius
              onHeightChanged: { if (root.selectedEmailIndex === index) Qt.callLater(root.ensureSelectedEmailVisible) }

              Column {
                id: emailColumn
                width: parent.width - Style.space(16)
                anchors.centerIn: parent
                spacing: Style.space(2)
                Text {
                  width: parent.width
                  text: (modelData.notification ? "󰂚 " : (root.expandedEmailIndex === index ? "󰁅 " : "󰁝 ")) + (root.selectedAccount === "__all__" ? "[" + (modelData.initials || "?") + "] " : "") + modelData.from + (modelData.date ? " · " + modelData.date : "")
                  color: Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  elide: Text.ElideRight
                }
                Text {
                  width: parent.width
                  text: modelData.subject || root.t("noSubject")
                  color: Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                }
                Text {
                  width: parent.width
                  text: root.expandedEmailIndex === index ? root.emailBodyText(modelData) : modelData.snippet
                  color: Qt.darker(Color.popups.text, 1.3)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  elide: root.expandedEmailIndex === index ? Text.ElideNone : Text.ElideRight
                  wrapMode: root.expandedEmailIndex === index ? Text.WordWrap : Text.NoWrap
                  maximumLineCount: root.expandedEmailIndex === index ? 0 : 1
                }
              }
              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openEmail(modelData)
              }
            }
          }
        }
      }
    }
  }

  onOpenedChanged: {
    if (root.opened) {
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      root.checkBridgeStatus()
      if (root.hostWidget) root.hostWidget.refresh()
    }
  }
}
