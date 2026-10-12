import { javascriptLanguage } from "@codemirror/lang-javascript";

// MV3 확장 페이지 CSP가 eval/new Function을 막으므로 에디터가 이미 쓰는 lezer 파서로 검사한다.
export function findSyntaxError(code: string): { line: number } | null {
  const tree = javascriptLanguage.parser.parse(code);
  let errorPos = -1;
  tree.iterate({
    enter(node) {
      if (errorPos >= 0) return false;
      if (node.type.isError) {
        errorPos = node.from;
        return false;
      }
      return undefined;
    },
  });
  if (errorPos < 0) return null;
  const line = code.slice(0, errorPos).split("\n").length;
  return { line };
}
