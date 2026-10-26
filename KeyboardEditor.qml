import QtQuick
import "KeyboardEditing.js" as Editing

TextEdit {
  id: field
  readOnly: true
  activeFocusOnPress: true
  cursorVisible: activeFocus
  textFormat: TextEdit.PlainText
  selectByMouse: true
  property int characterLimit: 60000
  property var undoSteps: []
  property var redoSteps: []
  signal closeRequested()
  signal submitRequested()
  signal pasteRequested()
  function snapshot() { return { text: text, cursor: cursorPosition } }
  function remember(state) {
    undoSteps = undoSteps.slice(-19).concat([state])
    redoSteps = []
  }
  function replaceSelection(value) {
    var before = snapshot()
    if (Editing.replaceSelection(field, value, characterLimit) && text !== before.text) remember(before)
  }
  function resetHistory() { undoSteps = []; redoSteps = [] }
  function restore(redo) {
    var source = redo ? redoSteps : undoSteps
    if (!source.length) return
    var state = source[source.length - 1], current = snapshot()
    if (redo) { redoSteps = source.slice(0, -1); undoSteps = undoSteps.concat([current]) }
    else { undoSteps = source.slice(0, -1); redoSteps = redoSteps.concat([current]) }
    text = state.text
    cursorPosition = state.cursor
  }
  Keys.onPressed: function(event) {
    var control = event.modifiers & (Qt.ControlModifier | Qt.MetaModifier)
    if (event.key === Qt.Key_Escape) { closeRequested(); event.accepted = true }
    else if (control && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) { submitRequested(); event.accepted = true }
    else if (control && (event.key === Qt.Key_Z || event.key === Qt.Key_Y)) {
      restore(event.key === Qt.Key_Y || !!(event.modifiers & Qt.ShiftModifier))
      event.accepted = true
    } else {
      var before = snapshot()
      if (Editing.handle(field, event, characterLimit, true) === "paste") pasteRequested()
      if (text !== before.text) remember(before)
    }
  }
}
