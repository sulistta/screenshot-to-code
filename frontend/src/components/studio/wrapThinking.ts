export function wrapThinking(text: string, width: number, measure: (text: string) => number): string[] {
  if (width <= 0) return [text];
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let offset = 0;
    while (offset < paragraph.length) {
      // Probe only one line, never repeatedly shape the entire remaining history.
      let high = Math.min(32, paragraph.length - offset);
      while (high < paragraph.length - offset && measure(paragraph.slice(offset, offset + high)) <= width) high = Math.min(high * 2, paragraph.length - offset);
      let low = 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(paragraph.slice(offset, offset + middle)) <= width) low = middle;
        else high = middle - 1;
      }
      let end = offset + low;
      if (end < paragraph.length) {
        const space = paragraph.lastIndexOf(" ", end - 1);
        if (space > offset) end = space + 1;
      }
      lines.push(paragraph.slice(offset, end));
      offset = end;
    }
    return lines.length ? lines : [""];
  });
}
