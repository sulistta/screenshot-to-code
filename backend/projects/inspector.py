"""Optional, inert-by-default element selection for the static preview."""

INSPECTOR = """<script>
(() => {
  let previous;
  let outline;
  const reset = () => { if (previous) previous.style.outline = outline; };
  document.addEventListener('mouseover', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    reset(); previous = event.target; outline = previous.style.outline;
    previous.style.outline = '2px solid #16a34a';
  }, true);
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    event.preventDefault(); event.stopImmediatePropagation(); reset();
    const element = event.target;
    const parts = [];
    let node = element;
    while (node && parts.length < 6) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part); node = node.parentElement;
    }
    parent.postMessage({type:'studio:element',selector:parts.join(' > ').slice(0,500),text:(element.textContent||'').trim().slice(0,500)}, '*');
  }, true);
})();
</script>"""


def with_inspector(document: str) -> str:
    marker = document.lower().rfind("</body>")
    return document[:marker] + INSPECTOR + document[marker:] if marker >= 0 else document + INSPECTOR
