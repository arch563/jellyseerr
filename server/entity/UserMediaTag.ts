import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import Media from './Media';
import { User } from './User';

@Entity()
@Index(['media', 'user'], { unique: true }) // Ensure one tag per user per media
export class UserMediaTag {
    @PrimaryGeneratedColumn()
    public id: number;

    @ManyToOne(() => Media, { nullable: false, onDelete: 'CASCADE' })
    public media: Media;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    public user: User;

    @Column({ type: 'varchar', length: 255 })
    public tag: string;

    @Column({ type: 'varchar', length: 255 })
    public displayTag: string;

    @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
    public createdAt: Date;

    constructor(init?: Partial<UserMediaTag>) {
        Object.assign(this, init);
    }
}

export default UserMediaTag;
