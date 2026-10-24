// Real Chromium computed-style regression; no live service or user session.
window.addEventListener("load", () => {
  try {
    const style = (element) => getComputedStyle(element);
    const stage = document.querySelector(".stage");
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const checkFontSizes = () => {
      for (const size of [24, 44, 65, 88]) {
        stage.style.setProperty("--caption-size", `${size}px`);
        for (const paragraph of stage.querySelectorAll(".caption-text p")) {
          assert(style(paragraph).fontSize === `${size}px`, `selected ${size}px became ${style(paragraph).fontSize} in ${document.body.className}`);
        }
      }
    };
    checkFontSizes();
    const clear = (element) => assert(style(element).backgroundColor === "rgba(0, 0, 0, 0)", `${element.tagName} has opaque background: ${style(element).backgroundColor}`);
    clear(document.documentElement);
    clear(document.body);
    clear(document.getElementById("projection"));
    assert(style(stage).backgroundColor === "rgba(18, 52, 86, 0)", "caption background must have zero alpha");
    for (const theme of ["light", "dark"]) {
      stage.dataset.theme = theme;
      assert(style(document.querySelector('[data-lane="zh"] .caption-text')).color === "rgb(255, 136, 0)", "custom Chinese color overridden");
      assert(style(document.querySelector('[data-lane="en"] .caption-text')).color === "rgb(0, 170, 255)", "custom English color overridden");
      for (const alpha of [0, 0.4, 1]) {
        stage.style.setProperty("--floating-bg", `rgba(18, 52, 86, ${alpha})`);
        const expected = alpha === 1 ? "rgb(18, 52, 86)" : `rgba(18, 52, 86, ${alpha})`;
        assert(style(stage).backgroundColor === expected, `background alpha ${alpha} overridden in ${theme}`);
        clear(document.body);
      }
    }
    document.body.classList.remove("native-overlay");
    assert(style(document.body).backgroundColor === "rgb(25, 41, 35)", "ordinary projector should retain opaque background");
    document.body.className = "floating-body";
    document.body.replaceChildren(stage);
    checkFontSizes();
    // Verify actual wrapped glyph rectangles, rather than CSS values alone.
    stage.querySelector('[data-lane="en"]').hidden = true;
    const box = stage.querySelector('[data-lane="zh"] .caption-text');
    const checkLines = (count) => {
      const bounds = box.getBoundingClientRect(), visible = new Set();
      assert(bounds.height <= count * parseFloat(style(box).lineHeight) + 1, "caption area exceeds the configured line count");
      for (const p of box.children) {
        let offset = 0;
        for (const character of p.textContent) {
          const range = document.createRange();
          range.setStart(p.firstChild, offset); offset += character.length; range.setEnd(p.firstChild, offset);
          const rect = range.getBoundingClientRect();
          if (rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1) visible.add(Math.round(rect.top));
        }
      }
      assert(visible.size === count, `expected ${count} visible lines, got ${visible.size} (${stage.className})`);
      const last = box.lastChild.firstChild, tail = document.createRange();
      tail.setStart(last, last.length - 1); tail.setEnd(last, last.length);
      const end = tail.getBoundingClientRect();
      assert(end.top >= bounds.top - 1 && end.bottom <= bounds.bottom + 1, "newest character is clipped");
    };
    for (const kind of ["floating-stage", "fullscreen-stage", "preview-stage"]) {
      stage.className = `stage ${kind} line-limited`;
      for (const width of [320, 720]) {
        stage.style.width = `${width}px`;
        for (const size of [24, 44]) {
          stage.style.setProperty("--caption-size", `${size}px`);
          for (const text of ["中文很长的字幕需要持续更新，并保留最新内容。".repeat(16), "Long English captions with mixed 中文 and emoji 🌏 ".repeat(16), "UnbrokenEnglishWord".repeat(30)]) {
            box.replaceChildren();
            for (const value of ["上一段旧字幕 Old paragraph.", text + "END"]) {
              const p = document.createElement("p"); p.textContent = value; box.append(p);
            }
            for (const count of [1, 2]) {
              stage.style.setProperty("--caption-max-lines", String(count));
              checkLines(count);
              const height = box.lastChild.getBoundingClientRect().height;
              box.lastChild.classList.add("partial");
              assert(box.lastChild.getBoundingClientRect().height === height, "streaming caret must not wrap onto an empty line");
              checkLines(count);
              box.lastChild.classList.remove("partial");
            }
          }
        }
      }
    }
    window.overlayTest.report({ ok: true });
  } catch (error) {
    window.overlayTest.report({ ok: false, message: error.message });
  }
});
