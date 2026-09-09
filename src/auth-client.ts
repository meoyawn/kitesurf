const main = document.querySelector("main");
const message = document.querySelector<HTMLElement>("#message");

async function post<T = { ok: boolean }>(path: string, payload: unknown = {}): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "omit",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request failed. Please try again.");
  return result;
}

function run(action: () => Promise<void>): void {
  if (message) message.textContent = "Working…";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  void action().catch(function failed(error: unknown) {
    if (message) message.textContent = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  }).finally(function finished() {
    for (const button of document.querySelectorAll("button")) button.disabled = false;
  });
}

document.querySelector("#key-form")?.addEventListener("submit", function submit(event) {
  event.preventDefault();
  run(async function submitKey() {
    const field = document.querySelector<HTMLInputElement>("#owner-key");
    const key = field?.value ?? "";
    if (field) field.value = "";
    if (main?.dataset.authorizing === "true") {
      const result = await post<{ redirectTo: string }>("/auth/consent", { key, query: location.search });
      location.assign(result.redirectTo);
      return;
    }
    await post("/auth/revoke", { key });
    if (message) message.textContent = "ChatGPT access revoked. Connect again to issue new tokens.";
  });
});
