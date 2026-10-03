"use client";
import { DiffEditor, loader, type DiffEditorProps } from "@monaco-editor/react";
loader.config({ paths: { vs: "/monaco/vs" } });
export default function CodeDiff(props: DiffEditorProps) {
  return <DiffEditor {...props} />;
}
