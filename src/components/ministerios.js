import verdade from '../imgs/ministerios/verdade.webp';
import prosperidade from '../imgs/ministerios/prosperidade.webp';
import defesa from '../imgs/ministerios/defesa.webp';
import educacao from '../imgs/ministerios/educacao.webp';
import saude from '../imgs/ministerios/saude.webp';
import ciencia from '../imgs/ministerios/ciencia.webp';
import bancoCentral from '../imgs/ministerios/banco-central.webp';
import inteligencia from '../imgs/ministerios/inteligencia.webp';

export const MINISTRY_EMBLEMS = { verdade, prosperidade, defesa, educacao, saude, ciencia };
export const BANCO_CENTRAL_EMBLEM = bancoCentral;
export const INTELIGENCIA_EMBLEM = inteligencia;

const TZ = 'America/Sao_Paulo';

export function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
  return date.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
