// Native controls stay read-only for their entire lifetime. Only key events and
// bounded helper output may change text; Qt never negotiates clipboard input.
function replaceSelection(field, value, limit) {
  var start = field.selectionStart, end = field.selectionEnd
  if (field.text.length - (end - start) + value.length > limit) return false
  field.remove(start, end)
  field.insert(start, value)
  field.cursorPosition = start + value.length
  return true
}

function handle(field, event, limit, multiline) {
  var altGr = !!(event.modifiers & Qt.GroupSwitchModifier) || !!((event.modifiers & Qt.ControlModifier) && (event.modifiers & Qt.AltModifier) && event.text && !/[\u0000-\u001f\u007f]/.test(event.text))
  var control = !altGr && (event.modifiers & (Qt.ControlModifier | Qt.MetaModifier))
  if ((control && event.key === Qt.Key_V) || (event.key === Qt.Key_Insert && (event.modifiers & Qt.ShiftModifier))) {
    event.accepted = true
    return "paste"
  }
  // Keep native copy, select-all, cursor movement and selection. No native cut,
  // paste, input-method or mouse/drop route ever makes the control editable.
  if (control) {
    if (event.key === Qt.Key_X) {
      field.copy()
      replaceSelection(field, "", limit)
      event.accepted = true
    }
    return ""
  }
  if (event.key === Qt.Key_Backspace || event.key === Qt.Key_Delete) {
    if (field.selectionStart !== field.selectionEnd) replaceSelection(field, "", limit)
    else {
      var pos = field.cursorPosition, start = pos, end = pos
      if (event.key === Qt.Key_Backspace && pos > 0) {
        start--
        if (start > 0 && /[\uDC00-\uDFFF]/.test(field.text.charAt(start)) && /[\uD800-\uDBFF]/.test(field.text.charAt(start - 1))) start--
      } else if (event.key === Qt.Key_Delete && pos < field.text.length) {
        end++
        if (/[\uD800-\uDBFF]/.test(field.text.charAt(pos)) && /[\uDC00-\uDFFF]/.test(field.text.charAt(end))) end++
      }
      field.remove(start, end)
      field.cursorPosition = start
    }
    event.accepted = true
  } else if (multiline && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
    replaceSelection(field, "\n", limit)
    event.accepted = true
  } else if (event.text && (altGr || !(event.modifiers & Qt.AltModifier)) && !/[\u0000-\u001f\u007f]/.test(event.text)) {
    replaceSelection(field, event.text, limit)
    event.accepted = true
  }
  return ""
}
