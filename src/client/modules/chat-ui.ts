/**
 * modules/chat-ui.ts — Chat UI controller.
 * Handles message rendering, input handling, and quick phrases.
 */

export interface ChatUICallbacks {
  onSend: (text: string) => void;
}

export class ChatUI {
  private logEl: HTMLElement | null;
  private inputEl: HTMLInputElement | null;
  private thinkingEl: HTMLElement | null;
  private callbacks: ChatUICallbacks;

  constructor(callbacks: ChatUICallbacks) {
    this.logEl = document.getElementById("chat-log");
    this.inputEl = document.getElementById("bubble-input") as HTMLInputElement;
    this.thinkingEl = document.getElementById("thinking");
    this.callbacks = callbacks;
    this.wire();
  }

  private wire(): void {
    // Send on Enter
    this.inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    // Send button
    document.getElementById("btn-bubble")?.addEventListener("click", () => this.send());

    // Quick phrases
    document.querySelectorAll(".phrase-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.textContent?.trim();
        if (text) {
          this.inputEl!.value = text;
          this.send();
        }
      });
    });
  }

  private send(): void {
    const text = this.inputEl?.value.trim();
    if (!text) return;
    this.addMessage("user", text);
    if (this.inputEl) this.inputEl.value = "";
    this.callbacks.onSend(text);
  }

  addMessage(role: "user" | "agent", text: string): void {
    if (!this.logEl || !text) return;
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = role === "agent" ? "AI" : "U";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = text;
    div.appendChild(avatar);
    div.appendChild(bubble);
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  setThinking(on: boolean): void {
    if (this.thinkingEl) {
      this.thinkingEl.classList.toggle("hidden", !on);
    }
  }

  getLogElement(): HTMLElement | null {
    return this.logEl;
  }
}
