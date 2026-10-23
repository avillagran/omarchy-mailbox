import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

// Guided Chrome connection. Google Chrome accepts this extension only from its
// own Extensions page, so this window walks through the three clicks and ticks
// each step off from Chrome's profile state. Nothing here needs elevation.
Item {
  id: root

  property var panel: null
  property string statusBin: Qt.resolvedUrl("bin/mailbox-bridge-status.js").toString().replace("file://", "")
  property string openBin: Qt.resolvedUrl("bin/mailbox-open-browser-extensions.js").toString().replace("file://", "")
  property string extensionPath: Qt.resolvedUrl("bridge-extension/source").toString().replace("file://", "")
  property string extensionFolder: Qt.resolvedUrl("bridge-extension").toString()
  property bool chromeOpened: false
  property bool developerMode: false
  property bool loaded: false
  property bool connected: false
  readonly property bool finished: root.loaded && root.connected
  readonly property int currentStep: !root.chromeOpened && !root.developerMode && !root.loaded ? 1 : !root.developerMode && !root.loaded ? 2 : !root.loaded ? 3 : !root.connected ? 4 : 5

  function t(key) { return root.panel ? root.panel.t(key) : key }
  function show() {
    root.chromeOpened = false
    window.visible = true
    if (!statusProc.running) statusProc.running = true
  }
  function openChrome(page) {
    Quickshell.execDetached(["node", root.openBin, "--chrome", page])
    if (page === "extensions") root.chromeOpened = true
  }

  Process {
    id: statusProc
    command: ["node", root.statusBin, "--chrome"]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var status = JSON.parse(text)
          root.developerMode = status.developerMode === true
          root.loaded = status.upToDate === true
          root.connected = root.loaded && String(status.runtimeVersion || "").length > 0
        } catch (_) {}
      }
    }
  }
  // Chrome writes its profile state a few seconds after each change.
  Timer { interval: 2000; repeat: true; running: window.visible && !root.finished; onTriggered: { if (!statusProc.running) statusProc.running = true } }
  onFinishedChanged: { if (root.finished && root.panel) root.panel.checkBridgeStatus() }

  component StepCard: Rectangle {
    id: card
    property int number: 0
    property string title: ""
    property string detail: ""
    property bool done: false
    readonly property bool current: root.currentStep === number
    default property alias actions: actionFlow.data
    width: parent ? parent.width : 0
    height: cardColumn.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    color: card.current ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14) : "transparent"
    border.width: 1
    border.color: card.current ? Color.accent : Qt.rgba(Color.muted.r, Color.muted.g, Color.muted.b, 0.4)
    opacity: card.done || card.current ? 1 : 0.6
    Behavior on color { ColorAnimation { duration: 160 } }

    Row {
      anchors.fill: parent
      anchors.margins: Style.space(10)
      spacing: Style.space(10)
      Rectangle {
        width: Style.space(26); height: width; radius: width / 2
        color: card.done ? Color.accent : "transparent"
        border.width: card.done ? 0 : 1
        border.color: card.current ? Color.accent : Color.muted
        Text { textFormat: Text.PlainText; anchors.centerIn: parent; text: card.done ? "󰄬" : String(card.number); color: card.done ? Color.background : Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
      }
      Column {
        id: cardColumn
        width: parent.width - Style.space(36)
        spacing: Style.space(6)
        Text { textFormat: Text.PlainText; width: parent.width; text: card.title; color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true; wrapMode: Text.WordWrap }
        Text { textFormat: Text.PlainText; width: parent.width; visible: text.length > 0; text: card.detail; color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; wrapMode: Text.WordWrap }
        Flow { id: actionFlow; width: parent.width; spacing: Style.space(8); visible: children.length > 0 }
      }
    }
  }

  FloatingWindow {
    id: window
    visible: false
    title: "Mailbox · Google Chrome"
    // Opaque: themes may give popups an alpha that lets windows show through.
    color: Qt.rgba(Color.popups.background.r, Color.popups.background.g, Color.popups.background.b, 1)
    implicitWidth: 460
    implicitHeight: content.implicitHeight + 48
    minimumSize: Qt.size(400, 420)

    Column {
      id: content
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: 24
      spacing: Style.space(12)

      // Header doubles as a grab handle: the window has no titlebar under
      // Hyprland, so pressing here hands the move to the compositor.
      Rectangle {
        id: header
        width: parent.width
        height: headerTitle.implicitHeight + Style.space(12)
        radius: Style.cornerRadius
        color: headerArea.containsMouse || headerArea.pressed ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.10) : "transparent"
        Behavior on color { ColorAnimation { duration: 120 } }
        Text { textFormat: Text.PlainText; id: headerTitle; anchors.left: parent.left; anchors.right: headerGrip.left; anchors.verticalCenter: parent.verticalCenter; text: "󰊯  " + root.t("Connect Google Chrome"); color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.heading; font.bold: true; elide: Text.ElideRight }
        Text { textFormat: Text.PlainText; id: headerGrip; anchors.right: parent.right; anchors.rightMargin: Style.space(4); anchors.verticalCenter: parent.verticalCenter; text: "󰇙󰇙"; color: Color.muted; opacity: headerArea.containsMouse ? 1 : 0.5; font.family: Style.font.family; font.pixelSize: Style.font.body }
        MouseArea {
          id: headerArea
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor
          onPressed: window.startSystemMove()
        }
      }
      Text { textFormat: Text.PlainText; width: parent.width; text: root.t("Chrome only accepts this extension from its own Extensions page. No password is needed, and each step is ticked off when Chrome reports it."); color: Color.muted; font.family: Style.font.family; font.pixelSize: Style.font.caption; wrapMode: Text.WordWrap }

      StepCard {
        number: 1
        title: root.t("Open Extensions in Chrome")
        detail: root.t("Chrome opens a new tab: paste with Ctrl+V and press Enter.")
        done: root.chromeOpened || root.developerMode || root.loaded
        Button { text: root.t("Open Chrome"); iconText: "󰊯"; bordered: true; onClicked: root.openChrome("extensions") }
      }
      StepCard {
        number: 2
        title: root.t("Turn on Developer mode")
        detail: root.t("It is the switch in the top-right corner of that page.")
        done: root.developerMode || root.loaded
      }
      StepCard {
        number: 3
        title: root.t("Drag Mailbox onto the page")
        detail: root.t("Drag this tile onto the Extensions page and drop it.")
        done: root.loaded

        Rectangle {
          id: dragTile
          width: Style.space(190); height: Style.space(40)
          radius: Style.cornerRadius
          color: tileArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.28) : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
          border.color: Color.accent
          Text { textFormat: Text.PlainText; anchors.centerIn: parent; text: "󰉋  Mailbox Local Bridge"; color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.caption; font.bold: true }
          // The visible tile stays put; this proxy carries the native drag.
          Item {
            id: dragProxy
            width: parent.width; height: parent.height
            Drag.dragType: Drag.Automatic
            Drag.supportedActions: Qt.CopyAction
            Drag.mimeData: ({ "text/uri-list": "file://" + encodeURI(root.extensionPath) + "\r\n" })
            Drag.active: tileArea.drag.active
          }
          MouseArea {
            id: tileArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: drag.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor
            drag.target: dragProxy
            onPressed: dragTile.grabToImage(function(result) { dragProxy.Drag.imageSource = result.url })
            drag.onActiveChanged: { if (!drag.active) { dragProxy.x = 0; dragProxy.y = 0 } }
          }
        }
        Button { text: root.t("Show folder"); iconText: "󰉋"; bordered: false; tooltipText: "bridge-extension/source"; onClicked: Qt.openUrlExternally(root.extensionFolder) }
      }
      StepCard {
        number: 4
        title: root.t("Reload Gmail and HEY")
        detail: root.t("Mailbox reads your Inbox from those open tabs.")
        done: root.connected
        Button { text: "Gmail"; iconText: "󰊫"; bordered: true; onClicked: root.openChrome("gmail") }
        Button { text: "HEY"; iconText: "󰇮"; bordered: true; onClicked: root.openChrome("hey") }
      }

      Item {
        width: parent.width
        height: Style.space(36)
        Text { textFormat: Text.PlainText; anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter; visible: root.finished; text: "󰄬  " + root.t("Chrome is connected."); color: Color.accent; font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true }
        Button { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; text: root.t("Close"); bordered: root.finished; onClicked: window.visible = false }
      }
    }
  }
}
