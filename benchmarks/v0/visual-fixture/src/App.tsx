import { useState } from 'react';

const FEATURES = [
  'Independent review on every revision',
  'Executed gates, not model claims',
  'Revision-bound evidence',
];

export default function App() {
  const [selected, setSelected] = useState(false);
  return (
    <main className="page">
      <div className="stage" data-testid="stage">
        <section className="pricing-card" data-testid="pricing-card">
          <p className="pricing-card__eyebrow">TEAM PLAN</p>
          <h1 className="pricing-card__title">Ship verified work</h1>
          <p className="pricing-card__price">
            $29<span>/seat</span>
          </p>
          <ul className="pricing-card__features">
            {FEATURES.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          <button
            className="pricing-card__cta"
            data-testid="cta"
            type="button"
            onClick={() => setSelected(true)}
          >
            Choose plan
          </button>
          {selected ? (
            <p className="pricing-card__toast" data-testid="toast" role="status">
              Plan selected
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
