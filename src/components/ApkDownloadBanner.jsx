import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

const DISMISS_KEY = 'ilc_apk_banner_dismissed_at';
const DISMISS_DAYS = 7;

// Na versão web aberta num celular Android, oferece baixar o APK do ILC Cidadão.
export default function ApkDownloadBanner() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!/Android/i.test(navigator.userAgent || '')) return;
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      if (at && Date.now() - at < DISMISS_DAYS * 86400000) return;
    } catch { /* sem storage */ }
    fetch('/api/app/android-version', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data && data.url) setInfo(data); })
      .catch(() => {});
  }, []);

  if (!info) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* sem storage */ }
    setInfo(null);
  };

  return (
    <div className="modal-overlay active" style={{ zIndex: 10000 }}>
      <div className="modal-card">
        <h2 className="modal-title">BAIXE O APP ILC CIDADÃO</h2>
        <p className="modal-desc">
          Tenha o ILC direto no seu Android, com login mais rápido e aviso automático de novas versões
          {info.versionName ? ` (versão ${info.versionName})` : ''}.
        </p>
        <p className="modal-desc" style={{ fontSize: '0.85em', opacity: 0.8 }}>
          Ao abrir o arquivo, o Android pode pedir para permitir a instalação deste navegador. É só aceitar.
        </p>
        <div className="form-buttons">
          <button type="button" className="state-btn secondary" onClick={dismiss}>AGORA NÃO</button>
          <a className="state-btn primary gold-glow" href={info.url} download="ILC-Cidadao.apk" onClick={dismiss}
             style={{ textAlign: 'center', textDecoration: 'none' }}>
            BAIXAR APK
          </a>
        </div>
      </div>
    </div>
  );
}
