import React from 'react';
import { SlideBase, HeaderBlock, ChecklistLayout, QuoteLayout, CTALayout } from './components/slide-system';

const Slides = () => {
  return (
    <div className="min-h-screen bg-[#F1F5F9] flex flex-col items-center py-20 gap-32">
      {/* Introduction */}
      <div className="max-w-2xl px-8 text-center space-y-4">
        <h1 className="text-4xl font-bold text-[#0F172A] tracking-tight">Us.v2 Pristine Tech Template</h1>
        <p className="text-[#64748B] text-lg leading-relaxed">
          Light Mode • Glassmorphism • Vector Circuit Patterns • Space Grotesk
        </p>
      </div>

      {/* Slide Container */}
      <div className="flex flex-col gap-40 w-full max-w-[1200px] items-center px-4">
        
        {/* S1: Cover */}
        <SlideWrapper id="slide-1" label="S1 COVER">
          <SlideBase slideNumber={1}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                variant="display"
                headline="Relationship Foundations"
                subhead="The clinical basics that prevent 80% of conflicts."
                autoFit
                centered
                isCover
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S2: Hook */}
        <SlideWrapper id="slide-2" label="S2 HOOK">
          <SlideBase slideNumber={2}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Healthy love is built, not found."
                subhead="Premium relationships are engineered through intentional, daily habits."
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S3: Truth */}
        <SlideWrapper id="slide-3" label="S3 TRUTH">
          <SlideBase slideNumber={3}>
            <QuoteLayout 
              quote="Consistency beats intensity every single time."
              attribution="Us.v2 Core Protocol"
              centered
            />
          </SlideBase>
        </SlideWrapper>

        {/* S4: Sign */}
        <SlideWrapper id="slide-4" label="S4 SIGN">
          <SlideBase slideNumber={4}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="3 signs your foundation is strong"
                centered
              />
              <ChecklistLayout 
                centered
                items={[
                  { lead: "Rapid Repair:", text: "Conflicts end with genuine reconnection, not silence." },
                  { lead: "Assumption Checks:", text: "You verify intentions instead of projecting fears." },
                  { lead: "Zero Performance:", text: "You don't have to earn basic care or affection." }
                ]} 
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S5: Mistake */}
        <SlideWrapper id="slide-5" label="S5 MISTAKE">
          <SlideBase slideNumber={5}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="The #1 silent killer"
                subhead="Unspoken expectations morphing into systemic resentment."
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S6: Reframe */}
        <SlideWrapper id="slide-6" label="S6 REFRAME">
          <SlideBase slideNumber={6}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Try this reframe"
                subhead="From ‘You should know’ → ‘Here is exactly what helps me feel safe.’"
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S7: Micro-Rule */}
        <SlideWrapper id="slide-7" label="S7 MICRO-RULE">
          <SlideBase slideNumber={7}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="The Teamwork Protocol"
                subhead="Solve every problem as ‘Us vs the Issue’ – never ‘Me vs You.’"
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S8: Action */}
        <SlideWrapper id="slide-8" label="S8 ACTION">
          <SlideBase slideNumber={8}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Weekly foundation habit"
                centered
              />
              <ChecklistLayout 
                centered
                items={[
                  { lead: "The 2-Minute Check:", text: "Daily sync, zero problem solving." },
                  { lead: "Radical Gratitude:", text: "Name one specific thing you admired today." },
                  { lead: "Verbal Clarity:", text: "State one need clearly without hint or subtext." }
                ]} 
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S9: Quote */}
        <SlideWrapper id="slide-9" label="S9 QUOTE">
          <SlideBase slideNumber={9}>
            <QuoteLayout 
              quote="Love is a skill. Practice it like your life depends on it."
              attribution="Us.v2 Methodology"
              centered
            />
          </SlideBase>
        </SlideWrapper>

        {/* S10: CTA */}
        <SlideWrapper id="slide-10" label="S10 CTA">
          <SlideBase slideNumber={10}>
            <CTALayout 
              text="Build the relationship you want. Get the 2026 Relationship Audit (Free)  —  Link in bio."
            />
          </SlideBase>
        </SlideWrapper>

      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@700&display=swap');
      ` }} />
    </div>
  );
};

const SlideWrapper = ({ children, id, label }: { children: React.ReactNode, id: string, label: string }) => {
  return (
    <div id={id} className="group flex flex-col items-center gap-6 w-full max-w-full overflow-hidden">
      <div className="flex items-center gap-4 w-full max-w-[810px]">
        <div className="h-px flex-1 bg-slate-300" />
        <span className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">{label}</span>
        <div className="h-px flex-1 bg-slate-300" />
      </div>
      <div className="relative shadow-xl shadow-slate-200 transition-transform duration-500 group-hover:scale-[1.01] overflow-hidden rounded-2xl bg-white border border-slate-100">
        <div className="w-[320px] h-[400px] sm:w-[432px] sm:h-[540px] md:w-[648px] md:h-[810px] lg:w-[810px] lg:h-[1012.5px] relative">
          <div className="absolute top-0 left-0 origin-top-left scale-[0.296] sm:scale-[0.4] md:scale-[0.6] lg:scale-[0.75] w-[1080px] h-[1350px]">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Slides;
