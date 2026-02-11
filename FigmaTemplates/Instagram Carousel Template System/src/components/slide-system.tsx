import React from 'react';
import { motion } from 'motion/react';
import { ImageWithFallback } from './figma/ImageWithFallback';

import logoImg from "figma:asset/f4b9277efdbeac925fbce6ac256bab38c1bde1bc.png";

// Constants based on brand guidelines
const COLORS = {
  bgBase: '#010931',
  bgGradient: '#06134A',
  textPrimary: '#F8F8FA',
  textSecondary: '#C9D1E3',
  neonGradient: 'linear-gradient(90deg, #2163CF 0%, #5C25A3 50%, #D92691 100%)',
  logoMagenta: 'linear-gradient(180deg, #F02288 0%, #9022A3 100%)',
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
  // Simple heuristic for font size calculation based on character count
  // for a 1080x1350 frame with margins
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
        fontSize: `${finalSize}px`,
        lineHeight: 0.9,
        fontWeight: 800,
        letterSpacing: '-0.04em',
        wordBreak: 'break-word',
        hyphens: 'auto'
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
        background: `radial-gradient(circle at center, ${COLORS.bgGradient} 0%, ${COLORS.bgBase} 100%)`,
        color: COLORS.textPrimary,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* 12-column Grid visualization (hidden by default, can be toggled if needed) */}
      <div className="absolute inset-0 pointer-events-none opacity-0 hover:opacity-10 transition-opacity">
        <div className="mx-[80px] h-full grid grid-cols-12 gap-4 border-x border-white/5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-full border-r border-white/5 last:border-r-0" />
          ))}
        </div>
      </div>

      {/* Content Area with margins */}
      <div className="flex-1 flex flex-col px-[80px] pt-[96px] pb-[96px]">
        {children}
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
          display: 'inline-block'
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
          fontSize: fontSize ? `${fontSize}px` : (isDisplay ? '120px' : '90px'),
          fontWeight: isDisplay ? 800 : 700,
          lineHeight: isDisplay ? (fontSize ? 0.9 : 0.95) : 1.1,
          letterSpacing: '-0.03em',
          maxWidth: centered ? '1000px' : '920px',
          color: fontSize ? '#FFFFFF' : COLORS.textPrimary // Pure white for the giant S1 text
        }}
      >
        {renderHeadline()}
      </h1>
      {subhead && (
        <p 
          style={{
            fontSize: '56px',
            fontWeight: 500,
            color: COLORS.textSecondary,
            lineHeight: 1.3,
            maxWidth: centered ? '900px' : '850px'
          }}
        >
          {subhead}
        </p>
      )}
    </div>
  );
};

// Checklist Variant
export const ChecklistLayout: React.FC<{ items: { lead: string; text: string }[], centered?: boolean }> = ({ items, centered = false }) => {
  return (
    <div className={`flex flex-col gap-[48px] mt-[48px] ${centered ? 'items-center text-center' : ''}`}>
      {items.map((item, i) => (
        <div key={i} className={`flex flex-col gap-[12px] ${centered ? 'items-center' : ''}`}>
          <div style={{ fontSize: '48px', fontWeight: 600 }}>
            {item.lead}
          </div>
          <div style={{ fontSize: '44px', fontWeight: 400, color: COLORS.textSecondary }}>
            {item.text}
          </div>
        </div>
      ))}
    </div>
  );
};

// Quote Variant
export const QuoteLayout: React.FC<{ quote: string; attribution: string, centered?: boolean }> = ({ quote, attribution, centered = false }) => {
  return (
    <div className={`flex-1 flex flex-col justify-center gap-[48px] ${centered ? 'items-center text-center' : ''}`}>
      <blockquote 
        style={{
          fontSize: '96px',
          fontWeight: 700,
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
        }}
      >
        “{quote}”
      </blockquote>
      <div 
        style={{
          fontSize: '40px',
          fontWeight: 500,
          color: COLORS.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
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
    <div className="flex-1 flex flex-col items-center justify-center gap-[80px] text-center">
      {/* Using the full logo image provided in the assets */}
      <div className="w-[900px]">
        <ImageWithFallback 
          src={logoImg} 
          alt="Us.v2 Logo" 
          className="w-full h-auto object-contain"
        />
      </div>
      <p 
        style={{
          fontSize: '52px',
          fontWeight: 500,
          lineHeight: 1.4,
          maxWidth: '920px',
          color: COLORS.textSecondary
        }}
      >
        {text}
      </p>
    </div>
  );
};
