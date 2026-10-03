import { useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { setupMonaco, CTH_MONACO_THEME, languageForPath } from './monaco';

setupMonaco();

export interface MonacoDiffProps {
  /** File path — drives syntax language only. */
  path: string;
  /** Left side (committed HEAD content). */
  original: string;
  /** Right side (current working-tree content). */
  modified: string;
}

/** Read-only side-by-side diff (working tree vs HEAD) backed by Monaco's
 *  built-in DiffEditor — the same dependency as the editor, no extra view layer. */
export function MonacoDiff({ path, original, modified }: MonacoDiffProps) {
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);

  // @monaco-editor/react disposes the models before the widget lets go of them,
  // which throws "TextModel got disposed before DiffEditorWidget model got
  // reset". We keep the models alive (keepCurrent*Model) and tear down in the
  // right order ourselves: detach, then dispose both models.
  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      editorRef.current = null;
      if (!editor) return;
      try {
        const model = editor.getModel();
        editor.setModel(null);
        model?.original?.dispose();
        model?.modified?.dispose();
      } catch {
        /* editor already disposed by the wrapper; nothing left to detach */
      }
    };
  }, []);

  return (
    <DiffEditor
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => { editorRef.current = editor; }}
      theme={CTH_MONACO_THEME}
      language={languageForPath(path)}
      original={original}
      modified={modified}
      loading={<div style={{ padding: 12, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)' }}>loading diff…</div>}
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        ignoreTrimWhitespace: false,
        renderOverviewRuler: false
      }}
    />
  );
}
