/** True when a single-key shortcut must not run (text fields, selects, YAML editor). */
export function isEditableTarget(target:EventTarget|null){
 if(!target||typeof (target as {closest?:unknown}).closest!=='function')return false;
 return !!(target as Element).closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],.yaml-editor,[aria-label="YAML form and code editor"]');
}
