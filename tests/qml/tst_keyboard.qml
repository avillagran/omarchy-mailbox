import QtQuick
import QtTest
import "../.."
import "../../KeyboardEditing.js" as Editing

Item {
  width: 500; height: 300
  KeyboardEditor { id: editor; width: 400; height: 150 }
  KeyboardInput { id: setting; y: 180; width: 100; height: 40; characterLimit: 3; allowedCharacters: "[0-9]" }
  SignalSpy { id: finishedSpy; target: setting; signalName: "editingFinished" }
  SignalSpy { id: pasteSpy; target: editor; signalName: "pasteRequested" }
  TestCase {
    name: "KeyboardControls"
    when: windowShown
    function keyClicks(value) { for (var i = 0; i < value.length; i++) keyClick(value.charAt(i)) }
    function init() { editor.text = ""; editor.resetHistory(); setting.text = ""; pasteSpy.clear(); editor.forceActiveFocus() }
    function test_typing_selection_delete_undo() {
      keyClicks("hola")
      compare(editor.text, "hola")
      compare(editor.readOnly, true)
      keyClick(Qt.Key_A, Qt.ControlModifier)
      keyClicks("mundo")
      compare(editor.text, "mundo")
      keyClick(Qt.Key_Z, Qt.ControlModifier)
      compare(editor.text, "mund")
      keyClick(Qt.Key_Y, Qt.ControlModifier)
      compare(editor.text, "mundo")
      keyClick(Qt.Key_Backspace)
      compare(editor.text, "mund")
      keyClick(Qt.Key_Return)
      keyClicks("fin")
      compare(editor.text, "mund\nfin")
      editor.select(0, 4)
      editor.replaceSelection("inicio")
      compare(editor.text, "inicio\nfin")
    }
    function test_paste_shortcuts_and_limit() {
      keyClick(Qt.Key_V, Qt.ControlModifier)
      keyClick(Qt.Key_Insert, Qt.ShiftModifier)
      compare(pasteSpy.count, 2)
      mouseClick(editor, 10, 10, Qt.MiddleButton)
      compare(editor.text, "")
      editor.characterLimit = 4
      editor.replaceSelection("1234")
      keyClicks("5")
      compare(editor.text, "1234")
      editor.select(1, 3)
      editor.replaceSelection("ab")
      compare(editor.text, "1ab4")
      editor.characterLimit = 60000
    }
    function test_settings_keys_only() {
      mouseClick(setting, 10, 10)
      verify(setting.activeFocus)
      keyClicks("12x34")
      compare(setting.text, "123")
      keyClick(Qt.Key_V, Qt.ControlModifier)
      keyClick(Qt.Key_Insert, Qt.ShiftModifier)
      mouseClick(setting, 10, 10, Qt.MiddleButton)
      compare(setting.text, "123")
      compare(setting.readOnly, true)
      keyClick(Qt.Key_A, Qt.ControlModifier)
      keyClicks("50")
      compare(setting.text, "50")
      keyClick(Qt.Key_Backspace)
      compare(setting.text, "5")
    }
    function test_settings_commit_once() {
      setting.forceActiveFocus()
      keyClicks("50")
      finishedSpy.clear()
      keyClick(Qt.Key_Return)
      compare(finishedSpy.count, 1)
      finishedSpy.clear()
      editor.forceActiveFocus()
      compare(finishedSpy.count, 1)
    }
    function test_altgr_text() {
      // Qt exposes AltGr as GroupSwitch, or Ctrl+Alt on some layouts.
      editor.replaceSelection("correo")
      // Exercise the same handler with the text produced by a keyboard layout.
      var result = { key: Qt.Key_At, text: "@", modifiers: Qt.ControlModifier | Qt.AltModifier, accepted: false }
      Editing.handle(editor, result, 60000, true)
      compare(editor.text, "correo@")
    }
    function test_unicode_delete() {
      editor.replaceSelection("a😀")
      keyClick(Qt.Key_Backspace)
      compare(editor.text, "a")
      editor.replaceSelection("😀b")
      editor.cursorPosition = 1
      keyClick(Qt.Key_Delete)
      compare(editor.text, "ab")
    }
  }
}
