/* Stitchline: React parts of the UI (Ark UI components), mounted by app.js into the panels it renders.
   Built by `npm run build:ui` (esbuild) into ui/react/islands.js, a plain script that app.js finds as
   window.STL_REACT. app.js renders its panels as HTML strings, so each mount returns { set, unmount }: app.js
   unmounts it before it replaces the panel. */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Slider } from '@ark-ui/react/slider';
import { LocaleProvider } from '@ark-ui/react/locale';

/* one value on a track with marks under it. onLive follows every move; onCommit gets the value once it settles
   (the drag ends, or the arrow keys stop for a moment) */
function ValueSlider({ init, min, max, step, marks = [], label, unit = '', onLive, onCommit, bind }) {
  const [v, setV] = useState(init);
  const timer = useRef(0);
  useEffect(() => {
    bind(setV);
    return () => clearTimeout(timer.current);
  }, []);
  return (
    <Slider.Root className="ark-slider" min={min} max={max} step={step} value={[v]} aria-label={[label]}
      onValueChange={d => { setV(d.value[0]); onLive?.(d.value[0]); }}
      onValueChangeEnd={d => { clearTimeout(timer.current); timer.current = setTimeout(() => onCommit(d.value[0]), 200); }}>
      <Slider.Control className="ark-slider-control">
        <Slider.Track className="ark-slider-track"><Slider.Range className="ark-slider-range" /></Slider.Track>
        <Slider.Thumb index={0} className="ark-slider-thumb"><Slider.HiddenInput /></Slider.Thumb>
      </Slider.Control>
      {marks.length > 0 && (
        <Slider.MarkerGroup className="ark-slider-marks">
          {marks.map(m => <Slider.Marker key={m} value={m} className="ark-slider-mark"><span data-notr>{m}{unit}</span></Slider.Marker>)}
        </Slider.MarkerGroup>
      )}
    </Slider.Root>
  );
}

/* Ark takes the reading direction from its locale, not from the page: Arabic lays the slider out right to left */
const inLocale = node => <LocaleProvider locale={document.documentElement.lang === 'ar' ? 'ar-EG' : 'en-US'}>{node}</LocaleProvider>;

window.STL_REACT = {
  mountSlider(el, opts) {
    const root = createRoot(el);
    let set = null;
    flushSync(() => root.render(inLocale(<ValueSlider {...opts} bind={f => (set = f)} />)));
    // opts.focus: the thumb had the focus before the panel re-rendered, so arrow keys keep working. Ark keeps the
    // thumb hidden (unfocusable) until it has measured it, so try again for a few frames
    let tries = opts.focus ? 10 : 0;
    const refocus = () => {
      const t = el.querySelector('[data-part="thumb"]');
      if (!t || !el.isConnected) return;
      t.focus({ preventScroll: true });
      if (document.activeElement !== t && --tries > 0) requestAnimationFrame(refocus);
    };
    if (tries) refocus();
    return { set: v => set?.(v), unmount: () => { tries = 0; root.unmount(); } };
  },
};
