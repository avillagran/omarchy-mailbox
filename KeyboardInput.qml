import QtQuick
import "KeyboardEditing.js" as Editing

TextInput {
  id: field
  readOnly: true
  activeFocusOnPress: true
  cursorVisible: activeFocus
  selectByMouse: true
  property int characterLimit: 3
  property string allowedCharacters: ".*"
  signal keyboardEdited()
  Keys.onPressed: function(event) {
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      editingFinished()
      event.accepted = true
      return
    }
    var before = text
    // Settings accept typed keys only, never clipboard data.
    if (event.text && !/[\u0000-\u001f\u007f]/.test(event.text) && !new RegExp("^(?:" + allowedCharacters + ")$").test(event.text)
        && !(event.modifiers & (Qt.ControlModifier | Qt.MetaModifier))) {
      event.accepted = true
      return
    }
    Editing.handle(field, event, characterLimit, false)
    if (text !== before) keyboardEdited()
  }
}
