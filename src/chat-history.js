// Text-only, in-memory history shared across feature modes in the active chat.
// Keep complete exchanges; screenshots are attached only to the current request.
function createChatHistory({ maxExchanges = 12, maxChars = 64_000 } = {}) {
  let epoch = 0;
  let exchanges = [];
  const marker = '\n[Earlier turn truncated]';
  const clip = text => {
    const limit = Math.floor(maxChars / 2);
    return text.length <= limit ? text : text.slice(0, limit - marker.length) + marker;
  };
  return {
    begin(text) {
      return {
        epoch,
        text,
        turns: [...exchanges.flat().map(turn => ({ ...turn })), { role: 'user', text }]
      };
    },
    complete(request, answer) {
      if (request.epoch !== epoch || typeof answer !== 'string' || !answer.trim()) return;
      exchanges.push([
        { role: 'user', text: clip(request.text) },
        { role: 'assistant', text: clip(answer) }
      ]);
      let size = exchanges.flat().reduce((sum, turn) => sum + turn.text.length, 0);
      while (exchanges.length > maxExchanges || size > maxChars) {
        const removed = exchanges.shift();
        size -= removed.reduce((sum, turn) => sum + turn.text.length, 0);
      }
    },
    clear() {
      epoch += 1;
      exchanges = [];
    }
  };
}

module.exports = { createChatHistory };
