(() => {
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text) parts.push(text);
      return;
    }
    if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"].includes(node.tagName) || node.hidden || node.getAttribute("aria-hidden") === "true") return;
    for (const child of node.childNodes) walk(child);
  }
  walk(document.body);
  const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role=button]")).map(function control(el) {
    return {
      ref: el._nid,
      tag: el.tagName.toLowerCase(),
      text: (el.getAttribute("aria-label") || el.textContent || "").trim(),
      href: el.getAttribute("href") ? el.href : undefined,
      type: el.getAttribute("type") || undefined,
      value: el.tagName === "INPUT" && el.type === "password" ? undefined : el.value,
    };
  });
  return { url: location.href, title: document.title, text: parts.join(" "), elements, truncated: false };
})()
