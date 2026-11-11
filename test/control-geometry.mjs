import assert from 'node:assert/strict';

export async function checkControlGeometry(page, label) {
  const geometry = await page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { height: box.height, width: box.width, x: box.x + box.width / 2, y: box.y + box.height / 2, radius: getComputedStyle(element).borderTopLeftRadius };
    };
    const add = document.querySelector('#attachment-menu > summary');
    const context = document.querySelector('.context-chip');
    const count = document.getElementById('attachment-count');
    const controls = [add, context, ...document.querySelectorAll('.buttons button')].filter(element => element.getClientRects().length).map(rect);
    const icons = [...document.querySelectorAll('.icon-button')].filter(element => element.getClientRects().length).map(element => {
      const svg = element.querySelector('svg');
      const decorativeRequired = element.matches('#attachment-menu > summary, #attachment-list button, #close-tab-picker');
      const bounds = svg?.getBBox();
      const glyph = bounds && new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(svg.getScreenCTM());
      return { button: rect(element), icon: svg && rect(svg), glyph: glyph && { x: glyph.x, y: glyph.y }, hidden: svg?.getAttribute('aria-hidden'), decorativeRequired };
    });
    const textRange = document.createRange();
    textRange.selectNodeContents(context.querySelector('#target'));
    const text = textRange.getBoundingClientRect();
    return { controls, icons, count: count.textContent ? rect(count) : null, textCenter: text.y + text.height / 2, context: rect(context) };
  });
  for (const control of geometry.controls) {
    assert.ok(Math.abs(control.height - 32) < 0.1, `${label}: 32px composer control, got ${control.height}`);
    assert.equal(control.radius, '7px', `${label}: shared composer radius`);
  }
  assert.ok(Math.abs(geometry.controls[0].y - geometry.context.y) < 0.1, `${label}: add and context controls aligned`);
  for (const { button, icon, glyph, hidden, decorativeRequired } of geometry.icons) {
    assert.ok(icon, `${label}: icon control uses an SVG, not a font glyph`);
    if (decorativeRequired) assert.equal(hidden, 'true', `${label}: decorative SVG is hidden from assistive technology`);
    if (decorativeRequired) assert.ok(Math.abs(button.x - glyph.x) < 0.1 && Math.abs(button.y - glyph.y) < 0.1, `${label}: visible glyph bounds centered, not just its SVG box`);
    assert.ok(Math.abs(button.x - icon.x) < 0.1 && Math.abs(button.y - icon.y) < 0.1, `${label}: SVG centered in its control`);
    assert.equal(button.width, 32, `${label}: square icon control width`);
    assert.equal(button.height, 32, `${label}: square icon control height`);
    assert.equal(button.radius, '7px', `${label}: icon radius`);
  }
  if (geometry.count) assert.ok(Math.abs(geometry.count.y - geometry.context.y) < 0.1, `${label}: source count aligned with context`);
  assert.ok(Math.abs(geometry.textCenter - geometry.context.y) <= 1, `${label}: selector text vertically centered`);
  return geometry;
}
