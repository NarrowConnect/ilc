import React from 'react';
import Icon from './Icon.jsx';

const parseSafeCertDate = (dateVal) => {
  if (!dateVal) return new Date().toLocaleDateString('pt-BR');
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    if (!trimmed) return '—';
    const isoLike = trimmed.includes(' ') && !trimmed.includes('T')
      ? trimmed.replace(' ', 'T')
      : trimmed;
    const dt = new Date(isoLike);
    if (!isNaN(dt.getTime())) return dt.toLocaleDateString('pt-BR');
  }
  const dt = new Date(dateVal);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('pt-BR');
};

const CertificatesGrid = ({ certificates = [] }) => {
  const officialDecorations = [
    {
      key: 'Estrela da Democracia',
      icon: 'sparkles',
      desc: 'Concedida por atos de coragem excepcionais em combate e serviço cívico extraordinário.',
      points: 100
    },
    {
      key: 'Ordem da Prosperidade',
      icon: 'cog',
      desc: 'Para quem impulsionou a economia, indústria, inovação ou infraestrutura nacional.',
      points: 500
    },
    {
      key: 'Medalha da Verdade',
      icon: 'book',
      desc: 'Para serviços excepcionais ao Ministério da Verdade, transparência e à informação.',
      points: 1000
    },
    {
      key: 'Cruz da Defesa Nacional',
      icon: 'swords',
      desc: 'Por bravura notável na defesa do território, da soberania cívica e do povo.',
      points: 2000
    },
    {
      key: 'Medalha da Expansão',
      icon: 'globe',
      desc: 'Concedida pela conquista, integração ou incorporação de novos territórios e parcerias.',
      points: 3500
    },
    {
      key: 'Ordem da Unidade',
      icon: 'handshake',
      desc: 'Para civis e militares que fortaleceram a coesão, a harmonia e a unidade da nação.',
      points: 5000
    },
    {
      key: 'Ordem Suprema do Alto Comando',
      icon: 'medal',
      desc: 'A maior honra da Democracia Gerenciada, concedida a poucos que serviram além do dever.',
      points: 8000
    }
  ];

  return (
    <div className="decorations-grid">
      {officialDecorations.map(dec => {
        const userCert = certificates.find(uc => 
          uc.name === dec.key || 
          uc.name.toLowerCase().includes(dec.key.toLowerCase().substring(0, 6))
        );
        const isUnlocked = !!userCert;
        const dateString = isUnlocked 
          ? parseSafeCertDate(userCert.granted_at)
          : null;
        
        return (
          <div key={dec.key} className={`decoration-card ${isUnlocked ? 'unlocked' : 'locked'}`}>
            <div className="decoration-icon-box">
              <Icon name={dec.icon} size={30} strokeWidth={1.5} />
            </div>
            <h4 className="decoration-title">{dec.key.toUpperCase()}</h4>
            <p className="decoration-desc">{dec.desc}</p>
            <div className={`decoration-status-pill ${isUnlocked ? 'granted' : 'locked'}`}>
              {isUnlocked
                ? <><Icon name="award" size={12} /> OUTORGADO ({dateString})</>
                : <><Icon name="lock" size={12} /> REQUER {dec.points} PTS</>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CertificatesGrid;

