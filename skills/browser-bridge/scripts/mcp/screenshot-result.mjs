// Image bytes stay out of text/structured JSON and are delivered as native MCP image content.
export function screenshotResult(value) {
  if (typeof value === 'string') return {content: [{type: 'text', text: value}], isError: false};
  return {content: [{type: 'text', text: value.filename}, value.image], isError: false};
}
