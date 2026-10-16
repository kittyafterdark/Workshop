import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Provider text is untrusted; only document markup and safe links reach the DOM. */
export function renderAgentMarkdown(text: string): HTMLElement {
  const body = document.createElement('div')
  body.className = 'workshop-agent-message-body'
  body.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['href', 'title', 'start'],
  })
  for (const link of body.querySelectorAll('a[href]')) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer') }
  return body
}
