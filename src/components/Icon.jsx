import React from 'react';
import {
  Landmark, Drama, Scale, Handshake, BookOpen, Leaf, ClipboardList, Vote, CalendarDays, MapPin, Users,
  Link2, MessageCircle, IdCard, ScrollText, Eye, ShieldCheck, CircleCheck, UserRound, ChartColumn,
  FilePen, Award, Settings, Folder, UserPlus, Pencil, Lock, Image, Tag, Zap, CircleX, Trash2, Hand,
  Ban, Star, ArrowDown, Crown, Hourglass, TriangleAlert, RefreshCw, Camera, KeyRound, ArrowLeft,
  Search, Sparkles, Cog, Swords, Globe, Medal, Upload, Smartphone, ChevronDown,
} from 'lucide-react';

// Ícones outline (Lucide, licença ISC, gratuita) usados no app inteiro.
// Use sempre pelo nome: <Icon name="calendar" />
const ICONS = {
  landmark: Landmark, drama: Drama, scale: Scale, handshake: Handshake, book: BookOpen, leaf: Leaf,
  clipboard: ClipboardList, vote: Vote, calendar: CalendarDays, pin: MapPin, users: Users, link: Link2,
  whatsapp: MessageCircle, idcard: IdCard, scroll: ScrollText, eye: Eye, shield: ShieldCheck,
  check: CircleCheck, user: UserRound, chart: ChartColumn, filepen: FilePen, award: Award,
  settings: Settings, folder: Folder, userplus: UserPlus, pencil: Pencil, lock: Lock, image: Image,
  tag: Tag, zap: Zap, x: CircleX, trash: Trash2, hand: Hand, ban: Ban, star: Star, down: ArrowDown,
  crown: Crown, hourglass: Hourglass, alert: TriangleAlert, refresh: RefreshCw, camera: Camera,
  key: KeyRound, back: ArrowLeft, search: Search, sparkles: Sparkles, cog: Cog, swords: Swords,
  globe: Globe, medal: Medal, upload: Upload, phone: Smartphone, chevron: ChevronDown,
};

export default function Icon({ name, size = 16, strokeWidth = 1.75, className = '', ...rest }) {
  const C = ICONS[name] || ClipboardList;
  return <C size={size} strokeWidth={strokeWidth} className={`ilc-icon ${className}`} aria-hidden="true" focusable="false" {...rest} />;
}

export const CATEGORY_ICON = {
  'cívico': 'landmark', 'cultural': 'drama', 'político': 'scale',
  'comunitário': 'handshake', 'educacional': 'book', 'ambiental': 'leaf',
};
