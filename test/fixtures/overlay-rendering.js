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
    window.overlayTest.report({ ok: true });
  } catch (error) {
    window.overlayTest.report({ ok: false, message: error.message });
  }
});
