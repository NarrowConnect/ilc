import React, { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

// Plugin nativo local (android/app/src/main/java/com/ilc/cidadao/AppUpdaterPlugin.java)
const AppUpdater = registerPlugin('AppUpdater');

const UPDATE_SERVER_URL = (import.meta.env.VITE_API_BASE_URL || 'https://ilc.narrowconnect.com.br')
  .replace(/\/$/, '')
  .replace(/\/api$/, '');

const SKIP_KEY = 'ilc_update_skipped_version';

// Ao abrir o APK, consulta o servidor. Se houver versão maior, mostra o aviso e
// baixa + abre o instalador do Android ali mesmo.
export default function AppUpdatePrompt() {
  const [update, setUpdate] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | permission | downloading | installing | error
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');

  const checkForUpdate = async () => {
    if (Capacitor.getPlatform() !== 'android') return;
    try {
      const info = await CapacitorApp.getInfo();
      const currentCode = parseInt(info.build, 10) || 0;
      const res = await fetch(`${UPDATE_SERVER_URL}/api/app/android-version`, { cache: 'no-store' });
      if (!res.ok) return;
      const latest = await res.json();
      if (!latest.url || !(latest.versionCode > currentCode)) return;
      let skipped = null;
      try { skipped = localStorage.getItem(SKIP_KEY); } catch { /* sem storage */ }
      if (!latest.mandatory && skipped === String(latest.versionCode)) return;
      setUpdate({ ...latest, currentName: info.version });
    } catch (err) {
      console.warn('Verificação de atualização falhou:', err);
    }
  };

  useEffect(() => {
    checkForUpdate();
    if (Capacitor.getPlatform() !== 'android') return;
    const progressListener = AppUpdater.addListener('downloadProgress', ({ percent: p }) => setPercent(p));
    return () => {
      progressListener.then(l => l.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDownload = async () => {
    if (!update) return;
    setError('');
    try {
      const { allowed } = await AppUpdater.canInstall();
      if (!allowed) {
        setPhase('permission');
        return;
      }
      setPercent(0);
      setPhase('downloading');
      await AppUpdater.downloadAndInstall({ url: UPDATE_SERVER_URL + update.url });
      setPhase('installing');
    } catch (err) {
      setError(err?.message || 'Não foi possível baixar a atualização.');
      setPhase('error');
    }
  };

  // Enquanto espera a permissão, confere a cada 1,5 s; quando o usuário volta com ela ativa, baixa sozinho
  useEffect(() => {
    if (phase === 'permission') {
      const t = setInterval(async () => {
        try {
          const { allowed } = await AppUpdater.canInstall();
          if (allowed) { clearInterval(t); startDownload(); }
        } catch { /* ignora */ }
      }, 1500);
      return () => clearInterval(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const skip = () => {
    try { localStorage.setItem(SKIP_KEY, String(update.versionCode)); } catch { /* sem storage */ }
    setUpdate(null);
  };

  if (!update) return null;

  return (
    <div className="modal-overlay active" style={{ zIndex: 10000 }}>
      <div className="modal-card">
        <h2 className="modal-title">NOVA VERSÃO DISPONÍVEL</h2>
        <p className="modal-desc">
          A versão {update.versionName} do ILC Cidadão está pronta
          {update.currentName ? ` (você está na ${update.currentName})` : ''}. Atualize para continuar com tudo funcionando.
        </p>
        {update.notes && <p className="modal-desc" style={{ whiteSpace: 'pre-line' }}>{update.notes}</p>}

        {phase === 'permission' && (
          <p className="modal-desc">
            O Android precisa da sua permissão para instalar a atualização. Na tela que abriu, ative
            <strong> "Permitir desta fonte"</strong> e volte para o app: o download começa sozinho.
          </p>
        )}
        {phase === 'downloading' && (
          <div style={{ margin: '12px 0' }}>
            <div style={{ height: 8, background: 'rgba(255,255,255,0.12)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: '#D4AF37', transition: 'width .2s' }} />
            </div>
            <p className="modal-desc" style={{ marginTop: 8 }}>Baixando... {percent}%</p>
          </div>
        )}
        {phase === 'installing' && (
          <p className="modal-desc">Download concluído. Toque em <strong>Instalar</strong> na tela do Android.</p>
        )}
        {phase === 'error' && <p className="modal-desc" style={{ color: '#ff6b6b' }}>{error}</p>}

        <div className="form-buttons">
          {!update.mandatory && phase !== 'downloading' && (
            <button type="button" className="state-btn secondary" onClick={skip}>AGORA NÃO</button>
          )}
          {phase === 'permission' ? (
            <button type="button" className="state-btn primary gold-glow" onClick={() => AppUpdater.openInstallSettings()}>
              DAR PERMISSÃO
            </button>
          ) : (
            <button
              type="button"
              className="state-btn primary gold-glow"
              disabled={phase === 'downloading'}
              onClick={startDownload}
            >
              {phase === 'installing' || phase === 'error' ? 'TENTAR DE NOVO' : 'ATUALIZAR AGORA'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
