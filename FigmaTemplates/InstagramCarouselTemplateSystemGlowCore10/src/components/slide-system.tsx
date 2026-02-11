import React from 'react';
import { motion } from 'motion/react';
import { ImageWithFallback } from './figma/ImageWithFallback';

import logoImg from "figma:asset/f4b9277efdbeac925fbce6ac256bab38c1bde1bc.png";

// Constants based on brand guidelines
const COLORS = {
  bgBase: '#050B1C',
  accentMagenta: '#FF007F',
  accentCyan: '#00F2FF',
  textPrimary: '#FFFFFF',
  textSecondary: '#A0AEC0',
  neonGradient: 'linear-gradient(90deg, #00F2FF 0%, #FF007F 100%)',
  glassBg: 'rgba(255, 255, 255, 0.03)',
  glassBorder: 'rgba(255, 255, 255, 0.1)',
};

/**
 * A helper component that scales text to fit its container
 */
const AutoFitText: React.FC<{ 
  text: string; 
  className?: string;
  maxFontSize?: number;
  minFontSize?: number;
}> = ({ text, className, maxFontSize = 300, minFontSize = 40 }) => {
  const length = text.length;
  let size = maxFontSize;
  
  if (length > 10) size = 260;
  if (length > 20) size = 200;
  if (length > 40) size = 150;
  if (length > 60) size = 100;
  if (length > 100) size = 80;
  
  const finalSize = Math.max(minFontSize, size);

  return (
    <div 
      className={className}
      style={{ 
        fontSize: `${Math.min(finalSize, 920 / (Math.max(...text.split(/\s+/).map(w => w.length), 1) * 0.65))}px`,
        lineHeight: 0.9,
        fontWeight: 700,
        letterSpacing: '-0.04em',
        wordBreak: 'normal',
        overflowWrap: 'normal',
        textAlign: 'center',
        fontFamily: "'Space Grotesk', sans-serif",
        textShadow: `0 0 20px ${COLORS.accentCyan}44`
      }}
    >
      {text}
    </div>
  );
};

// Slide Base Component
interface SlideBaseProps {
  children: React.ReactNode;
  slideNumber: number;
  totalSlides?: number;
}

export const SlideBase: React.FC<SlideBaseProps> = ({ children, slideNumber, totalSlides = 10 }) => {
  return (
    <div 
      className="relative flex flex-col overflow-hidden select-none"
      style={{
        width: '1080px',
        height: '1350px',
        backgroundColor: COLORS.bgBase,
        color: COLORS.textPrimary,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* Google Fonts Import */}
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;500;600&display=swap');
      `}} />

      {/* Circuit Pattern Overlay */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(${COLORS.accentCyan}11 1px, transparent 1px),
            linear-gradient(90deg, ${COLORS.accentCyan}11 1px, transparent 1px)
          `,
          backgroundSize: '80px 80px',
        }}
      />
      
      {/* Additional Circuit Accents */}
      <div className="absolute top-0 right-0 w-[400px] h-[400px] pointer-events-none opacity-10">
        <svg width="100%" height="100%" viewBox="0 0 400 400">
          <path d="M400,0 L350,50 L350,150 L300,200 L100,200 L50,250 L0,250" fill="none" stroke={COLORS.accentCyan} strokeWidth="2" />
          <circle cx="350" cy="50" r="4" fill={COLORS.accentCyan} />
          <circle cx="100" cy="200" r="4" fill={COLORS.accentCyan} />
        </svg>
      </div>

      {/* Glow Orbs */}
      <div 
        className="absolute -top-[200px] -left-[200px] w-[600px] h-[600px] rounded-full blur-[120px] pointer-events-none"
        style={{ background: `${COLORS.accentMagenta}11` }}
      />
      <div 
        className="absolute -bottom-[200px] -right-[200px] w-[600px] h-[600px] rounded-full blur-[120px] pointer-events-none"
        style={{ background: `${COLORS.accentCyan}11` }}
      />

      {/* Content Area with margins */}
      <div className="flex-1 flex flex-col px-[80px] pt-[96px] pb-[96px] z-10">
        {children}
      </div>

      {/* Slide Progress Indicator (UI Style) */}
      <div className="absolute bottom-8 left-[80px] flex items-center gap-4 text-[14px] font-mono tracking-widest text-[#4A5568]">
        <span className="text-accentCyan">{String(slideNumber).padStart(2, '0')}</span>
        <div className="w-[100px] h-[2px] bg-white/10 overflow-hidden">
          <div 
            className="h-full bg-accentCyan shadow-[0_0_10px_#00F2FF]" 
            style={{ width: `${(slideNumber / totalSlides) * 100}%` }} 
          />
        </div>
        <span>{String(totalSlides).padStart(2, '0')}</span>
      </div>
    </div>
  );
};

// Header Block Component
interface HeaderBlockProps {
  headline: string | React.ReactNode;
  subhead?: string;
  variant?: 'display' | 'title';
  gradientWords?: string[];
}

export const HeaderBlock: React.FC<HeaderBlockProps & { centered?: boolean, fontSize?: number, autoFit?: boolean }> = ({ headline, subhead, variant = 'title', gradientWords = [], centered = false, fontSize, autoFit = false }) => {
  const isDisplay = variant === 'display';
  
  const renderHeadline = () => {
    if (typeof headline !== 'string') return headline;
    
    if (autoFit) {
      return <AutoFitText text={headline} />;
    }

    if (gradientWords.length === 0) return headline;

    const parts = headline.split(' ');
    return parts.map((part, i) => {
      const cleanPart = part.replace(/[.,!]/g, '');
      const shouldGradient = gradientWords.some(gw => cleanPart.toLowerCase() === gw.toLowerCase());
      
      return (
        <span key={i} style={shouldGradient ? { 
          background: COLORS.neonGradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          display: 'inline-block',
          textShadow: 'none'
        } : {}}>
          {part}{i < parts.length - 1 ? ' ' : ''}
        </span>
      );
    });
  };

  return (
    <div className={`flex flex-col gap-[32px] mb-[64px] ${centered ? 'items-center text-center' : ''}`}>
      <h1 
        style={{
          fontSize: fontSize ? `${fontSize}px` : (isDisplay ? '110px' : '84px'),
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '-0.04em',
          maxWidth: centered ? '1000px' : '920px',
          fontFamily: "'Space Grotesk', sans-serif",
          textShadow: `0 0 30px ${COLORS.accentCyan}33`
        }}
      >
        {renderHeadline()}
      </h1>
      {subhead && (
        <p 
          style={{
            fontSize: '48px',
            fontWeight: 400,
            color: COLORS.textSecondary,
            lineHeight: 1.4,
            maxWidth: centered ? '900px' : '850px',
            fontFamily: "'Inter', sans-serif"
          }}
        >
          {subhead}
        </p>
      )}
    </div>
  );
};

// Checklist Variant (Glassmorphism)
export const ChecklistLayout: React.FC<{ items: { lead: string; text: string }[], centered?: boolean }> = ({ items, centered = false }) => {
  return (
    <div className={`flex flex-col gap-[32px] mt-[48px] ${centered ? 'items-center text-center' : ''}`}>
      {items.map((item, i) => (
        <div 
          key={i} 
          className="p-8 rounded-2xl border backdrop-blur-md"
          style={{
            backgroundColor: COLORS.glassBg,
            borderColor: COLORS.glassBorder,
          }}
        >
          <div className="flex flex-col gap-[8px]">
            <div style={{ fontSize: '44px', fontWeight: 700, color: COLORS.accentCyan, fontFamily: "'Space Grotesk', sans-serif" }}>
              {item.lead}
            </div>
            <div style={{ fontSize: '38px', fontWeight: 400, color: COLORS.textSecondary }}>
              {item.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Quote Variant
export const QuoteLayout: React.FC<{ quote: string; attribution: string, centered?: boolean }> = ({ quote, attribution, centered = false }) => {
  return (
    <div className={`flex-1 flex flex-col justify-center gap-[64px] ${centered ? 'items-center text-center' : ''}`}>
      <div 
        className="p-12 rounded-[40px] border relative"
        style={{
          backgroundColor: COLORS.glassBg,
          borderColor: COLORS.glassBorder,
          backdropFilter: 'blur(10px)'
        }}
      >
        <span className="absolute -top-10 left-10 text-[160px] leading-none opacity-20 font-serif" style={{ color: COLORS.accentCyan }}>“</span>
        <blockquote 
          style={{
            fontSize: '84px',
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            fontFamily: "'Space Grotesk', sans-serif"
          }}
        >
          {quote}
        </blockquote>
      </div>
      <div 
        style={{
          fontSize: '32px',
          fontWeight: 600,
          color: COLORS.accentMagenta,
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          fontFamily: "'Space Grotesk', sans-serif"
        }}
      >
        — {attribution}
      </div>
    </div>
  );
};

// CTA Variant
export const CTALayout: React.FC<{ text: string }> = ({ text }) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-[64px] text-center">
      <div 
        className="p-4 rounded-[60px] border shadow-[0_0_50px_rgba(0,242,255,0.1)]"
        style={{
          backgroundColor: COLORS.glassBg,
          borderColor: COLORS.glassBorder,
        }}
      >
        <div className="w-[600px]">
          <ImageWithFallback 
            src={logoImg} 
            alt="Us.v2 Logo" 
            className="w-full h-auto object-contain rounded-[48px]"
          />
        </div>
      </div>
      <div className="flex flex-col gap-6">
        <p 
          style={{
            fontSize: '72px',
            fontWeight: 700,
            lineHeight: 1.1,
            maxWidth: '920px',
            color: '#FFFFFF',
            fontFamily: "'Space Grotesk', sans-serif",
            textShadow: `0 0 20px ${COLORS.accentCyan}44`
          }}
        >
          Build the relationship you want.
        </p>
        <div className="flex flex-col gap-2">
          <p 
            style={{
              fontSize: '40px',
              fontWeight: 400,
              lineHeight: 1.4,
              maxWidth: '850px',
              color: COLORS.textSecondary
            }}
          >
            First 250 subscribers get early access to Us.v2 app — join via link in bio.
          </p>
          <div className="mt-4 flex justify-center">
            <div className="px-8 py-3 rounded-full border border-accentCyan text-accentCyan text-2xl font-bold tracking-widest uppercase shadow-[0_0_15px_rgba(0,242,255,0.3)]">
              Link in Bio
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
