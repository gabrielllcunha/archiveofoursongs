import classNames from "classnames";
import styles from "./styles.module.scss";
import { ImageIcon } from "@radix-ui/react-icons";
import Image from "next/image";

interface MonthItemProps {
  month: string;
  imageUrl?: string;
  name?: string;
  artist?: string;
  scrobbles?: number;
  rounded?: boolean;
  onClick?: () => void;
}

export function MonthItem({ month, imageUrl, name, artist, scrobbles, rounded, onClick }: MonthItemProps) {
  return (
    <div className={styles.monthItem}>
      <div className={styles.monthName}>{month}</div>
      <div
        className={classNames(styles.imageBox, {
          [styles.rounded]: rounded,
          [styles.interactive]: Boolean(onClick),
        })}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick();
                }
              }
            : undefined
        }
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
      >
        {imageUrl ? (
          <Image
            src={imageUrl}
            width={150}
            height={150}
            alt={name || ""}
            className={styles.image}
          />
        ) : (
          <div className={styles.placeholderWrapper}>
            <ImageIcon className={styles.placeholderIcon} />
          </div>
        )}
      </div>
      <div className={classNames(styles.itemMeta, rounded && styles.itemMetaArtist)}>
        {rounded ? (
          <>
            {name && <span className={styles.itemName} title={name}>{name}</span>}
            {scrobbles && <span className={styles.scrobblesQty}><b>{scrobbles}</b> scrobbles</span>}
          </>
        ) : (
          <>
            {name && <span className={styles.itemName} title={`❝${name}❞`}>❝{name}❞</span>}
            {artist && <span className={styles.artistName} title={`by ${artist}`}>by {artist}</span>}
            {scrobbles && <span className={styles.scrobblesQty}><b>{scrobbles}</b> scrobbles</span>}
          </>
        )}
      </div>
    </div>
  );
}
