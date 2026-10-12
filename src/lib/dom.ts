type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "children">> & {
  class?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, dataset, ...rest } = props;
  if (cls) node.className = cls;
  if (dataset) Object.assign(node.dataset, dataset);
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

export function $<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`요소 없음: ${selector}`);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
