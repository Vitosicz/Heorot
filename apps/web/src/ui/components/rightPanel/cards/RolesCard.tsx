import React from "react";

interface RolesCardProps {
    roleLabel: string;
    roleBadgeClass: string;
    mutualRoomsCount: number;
}

export function RolesCard({ roleLabel, roleBadgeClass, mutualRoomsCount }: RolesCardProps): React.ReactElement {
    return (
        <section className="rp-card">
            <header className="rp-card-header">
                <h3 className="rp-card-title">Mutual context</h3>
            </header>
            <div className="rp-row">
                <span className="rp-row-label">Role</span>
                <span className={`rp-role-badge ${roleBadgeClass}`}>{roleLabel}</span>
            </div>
            <div className="rp-row">
                <span className="rp-row-label">Mutual rooms</span>
                <span className="rp-row-value">{mutualRoomsCount}</span>
            </div>
        </section>
    );
}
