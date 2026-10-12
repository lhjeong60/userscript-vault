import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";

export interface Editor {
  getValue(): string;
  setValue(code: string): void;
  setEnabled(on: boolean): void;
}

export function createEditor(parent: HTMLElement, hooks: { onChange(): void; onSave(): void }): Editor {
  const editable = new Compartment();
  const theme = new Compartment();
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const themeFor = (dark: boolean) => (dark ? oneDark : []);
  let applyingExternal = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        javascript(),
        Prec.highest(keymap.of([{ key: "Mod-s", run: () => { hooks.onSave(); return true; } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal) hooks.onChange();
        }),
        editable.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
        theme.of(themeFor(darkQuery.matches)),
      ],
    }),
  });
  darkQuery.addEventListener("change", (e) => view.dispatch({ effects: theme.reconfigure(themeFor(e.matches)) }));

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (code) => {
      applyingExternal = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
      applyingExternal = false;
    },
    setEnabled: (on) => {
      view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(on), EditorState.readOnly.of(!on)]) });
    },
  };
}
