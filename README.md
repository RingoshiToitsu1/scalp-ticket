# Scalp Ticket

One static page. Drop a 1-minute chart screenshot, get a trade ticket: bias, entry,
stop, targets, and the structure read behind them.

- No build step, no server, no backend — `index.html` is the whole app.
- It calls the Anthropic Messages API (`claude-opus-5`) straight from the browser.
- Your API key is pasted into the page and kept in that browser's `localStorage`.
  It is never committed, never sent anywhere but `api.anthropic.com`.

The risk:reward, stop distance and position size shown on the ticket are recomputed
by the page from the levels themselves — where the model's own arithmetic disagrees
with its levels, the page says so and the levels win.

Not advice. One model's opinion of one screenshot.
