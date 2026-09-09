(() => {
  const parts = [];
  let length = 0;
  function walk(node) {
    if (length >= 20000) return;
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text) { parts.push(text); length += text.length; }
      return;
    }
    if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"].includes(node.tagName) || node.hidden || node.getAttribute("aria-hidden") === "true") return;
    for (const child of node.childNodes) walk(child);
  }
  walk(document.body);
  const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role=button]")).slice(0, 200).map(function control(el) {
    return {
      ref: el._nid,
      tag: el.tagName.toLowerCase(),
      text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 160),
      href: el.getAttribute("href") ? el.href : undefined,
      type: el.getAttribute("type") || undefined,
      value: el.tagName === "INPUT" && el.type === "password" ? undefined : el.value?.slice(0, 2048),
    };
  });
  return { url: location.href, title: document.title, text: parts.join(" ").slice(0, 20000), elements, truncated: length >= 20000 };
})()
