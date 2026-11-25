import React, { useEffect, useRef, useState } from 'react';

// Número que "sobe" até o valor final (micro interação dos placares).
// Respeita quem pediu menos movimento no sistema.
export default function CountUp({ value, duration = 900, className, style }) {
  const target = Number(value);
  const valid = Number.isFinite(target);
  const decimals = valid && String(value).includes('.') ? String(value).split('.')[1].length : 0;
  const [shown, setShown] = useState(valid ? 0 : value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!valid) { setShown(value); return undefined; }
    const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(target); fromRef.current = target; return undefined; }
    const from = fromRef.current;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const text = valid ? Number(shown).toFixed(decimals) : shown;
  return <span className={className} style={style}>{text}</span>;
}
