import type { z } from "zod";
import type { browserSchemas } from "./browser-schema.ts";
import { normalizeBrowserUrl, type BrowserNetwork } from "./browser-network.ts";

export type ReadSection = { heading: string; level: number; text: string };
export type ReadDocument = { url: string; title: string; sections: ReadSection[]; raw?: string };
type ReadOptions = z.output<typeof browserSchemas.browser_read>;

/** HTML parsing uses the existing native DOM without bootstrapping scripts or loading resources. */
export const readHtmlScript = String.raw`(() => {
  const dom = Deno.core.ops.op_dom;
  function get(command, id = '', value = '') { return dom(command, String(id), value); }
  let root = get('query_selector','main,article,[role=main]');
  if (root < 0) root = get('query_selector','body');
  const sections = [];
  let heading = '', level = 0, body = [];
  function flush() { if (heading || body.length) sections.push({heading,level,text:body.join(' ').replace(/\s+/g,' ').trim()}); body=[]; }
  function walk(id) {
    const type=get('node_type',id);
    if (type === 3) { const content=get('text_content',id).trim(); if(content) body.push(content); return; }
    if(type !== 1) return;
    const tag=get('tag_name',id).toUpperCase();
    if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','FOOTER'].includes(tag) || get('get_attribute',id,'hidden') !== null || get('get_attribute',id,'aria-hidden') === 'true') return;
    if(/^H[1-6]$/.test(tag)) { flush(); heading=get('text_content',id).replace(/\s+/g,' ').trim(); level=Number(tag[1]); return; }
    for(const child of get('child_nodes',id)) walk(child);
  }
  if(root >= 0) walk(root);
  flush();
  return {url:get('document_url'),title:get('document_title'),sections};
})()`;

function markdownSections(content: string): ReadSection[] {
  const sections: ReadSection[] = [];
  let heading = "", level = 0, lines: string[] = [], fence = "";
  function flush() {
    if (heading || lines.length) sections.push({ heading, level, text: lines.join("\n").trim() });
    lines = [];
  }
  for (const line of content.split("\n")) {
    const fenced = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenced) fence = fence ? "" : fenced[1][0];
    const match = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) { flush(); heading = match[2]; level = match[1].length; }
    else lines.push(line);
  }
  flush();
  return sections;
}

export function formatRead(document: ReadDocument, options: Pick<ReadOptions, "raw" | "filter" | "outline">) {
  if (options.raw) return document.raw || "";
  const filter = options.filter?.toLocaleLowerCase();
  const selected: ReadSection[] = [];
  let parentLevel: number | undefined;
  for (const section of document.sections) {
    if (parentLevel !== undefined && section.level <= parentLevel) parentLevel = undefined;
    const headingMatches = Boolean(filter && section.heading.toLocaleLowerCase().includes(filter));
    if (headingMatches) parentLevel = section.level;
    if (!filter || headingMatches || parentLevel !== undefined || !options.outline && section.text.toLocaleLowerCase().includes(filter)) selected.push(section);
  }
  return selected.map(function format(section) {
    const heading = section.heading ? "#".repeat(section.level || 1) + " " + section.heading : "";
    return options.outline ? heading : [heading, section.text].filter(Boolean).join("\n\n");
  }).filter(Boolean).join("\n\n");
}

function links(content: string, base: string) {
  const result: { title: string; url: string }[] = [];
  for (const match of content.matchAll(/\[([^\]]+)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    try { result.push({ title: match[1], url: new URL(match[2], base).href }); } catch { /* Ignore malformed page links. */ }
  }
  return result;
}

/** Explicit URL reads use their own unauthenticated request context and never change tabs. */
export async function readBrowserUrl(options: ReadOptions, network: BrowserNetwork, parseHtml: (url: string, html: string) => Promise<ReadDocument>) {
  const url = normalizeBrowserUrl(options.url!);
  if (url === "about:blank") throw new Error("URL reads require HTTP(S)");
  const requested = new URL(url);
  async function download(url: string) {
    const response = await network.download(url, { headers: { accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" } });
    network.throwIfAborted();
    return response;
  }
  async function optional(url: string) {
    const response = await download(url);
    return response.status >= 200 && response.status < 300 ? response : undefined;
  }
  async function nearest(filename: string) {
    const candidate = new URL(requested);
    candidate.search = ""; candidate.hash = "";
    const paths = candidate.pathname.split("/");
    paths.pop();
    while (paths.length) {
      candidate.pathname = paths.join("/").replace(/\/$/, "") + "/" + filename;
      const response = await optional(candidate.href);
      if (response && !/text\/html/i.test(new Headers(response.headers).get("content-type") || "")) return response;
      paths.pop();
    }
  }
  const markdown = (response: Awaited<ReturnType<typeof download>>) => /^text\/markdown(?:\s*;|$)/i.test(new Headers(response.headers).get("content-type") || "");
  if (options.llms) {
    const resource = await nearest(options.llms === "full" ? "llms-full.txt" : "llms.txt");
    if (!resource) throw new Error("No ancestor " + (options.llms === "full" ? "llms-full.txt" : "llms.txt") + " found");
    const content = options.llms === "index" ? links(resource.body, resource.url).filter(function match(link) {
      return !options.filter || (link.title + " " + link.url).toLocaleLowerCase().includes(options.filter.toLocaleLowerCase());
    }).map(link => "- [" + link.title + "](" + link.url + ")").join("\n") : formatRead({ url: resource.url, title: "", sections: markdownSections(resource.body), raw: resource.body }, options);
    return { url: resource.url, requestedUrl: url, source: "llms-" + options.llms, content };
  }
  let response = await download(url);
  if (!options.raw && !markdown(response) && (options.requireMd || !/^text\/plain(?:;|$)/i.test(new Headers(response.headers).get("content-type") || ""))) {
    const mdUrl = new URL(requested);
    mdUrl.pathname = mdUrl.pathname.replace(/\/$/, "") + ".md";
    const md = await optional(mdUrl.href);
    if (md && markdown(md)) response = md;
    else {
      const index = await nearest("llms.txt");
      const match = index && links(index.body, index.url).find(function matching(link) {
        const linked = new URL(link.url);
        return linked.origin === requested.origin && linked.pathname.replace(/\.md$/, "").replace(/\/$/, "") === requested.pathname.replace(/\/$/, "");
      });
      if (match) { const linked = await optional(match.url); if (linked && markdown(linked)) response = linked; }
    }
  }
  if (response.status < 200 || response.status >= 300) throw new Error("Read failed: HTTP " + response.status);
  if (options.requireMd && !markdown(response)) throw new Error("Read requires Content-Type: text/markdown");
  if (options.raw) return { url: response.url, requestedUrl: url, source: "raw", content: response.body };
  const isText = markdown(response) || /^text\/plain(?:;|$)/i.test(new Headers(response.headers).get("content-type") || "");
  const document = isText ? { url: response.url, title: "", sections: markdownSections(response.body) } : await parseHtml(response.url, response.body);
  return { url: response.url, requestedUrl: url, title: document.title, source: markdown(response) ? "markdown" : isText ? "text" : "html", content: formatRead(document, options) };
}
