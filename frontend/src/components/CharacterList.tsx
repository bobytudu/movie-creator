import React from 'react';
import { Character } from '../types';

interface CharacterListProps {
  characters: Character[];
}

export const CharacterList: React.FC<CharacterListProps> = ({ characters }) => {
  return (
    <div className="characters-card">
      <h2 className="card-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Character Profiles
      </h2>
      <div className="character-list">
        {characters.map((char, index) => (
          <div key={index} className="character-item">
            <p className="character-name">
              <span>{char.name}</span>
              <span className="character-role-badge">{char.role}</span>
            </p>
            <p className="character-desc">{char.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
