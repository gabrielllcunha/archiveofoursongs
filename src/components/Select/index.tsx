import styles from "./styles.module.scss";
import * as RadixSelect from "@radix-ui/react-select";
import { ChevronDownIcon, ChevronUpIcon, CheckIcon } from "@radix-ui/react-icons";
import { Spinner } from "../Spinner";

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    items: { value: string; label: string; disabled?: boolean }[];
    label?: string;
    className?: string;
    loading?: boolean;
}

export function Select({ value, onChange, items, label, className, loading = false }: SelectProps) {
    return (
        <RadixSelect.Root value={value} onValueChange={onChange}>
            <RadixSelect.Trigger className={`${styles.trigger} ${className ?? ""}${loading ? ` ${styles.triggerLoading}` : ""}`} aria-label={label} aria-busy={loading}>
                <RadixSelect.Value />
                <RadixSelect.Icon className={styles.icon}>
                    {loading ? <Spinner size="small" /> : <ChevronDownIcon />}
                </RadixSelect.Icon>
            </RadixSelect.Trigger>

            <RadixSelect.Portal>
                <RadixSelect.Content className={styles.content} position="popper">
                    <RadixSelect.ScrollUpButton className={styles.scrollButton}>
                        <ChevronUpIcon />
                    </RadixSelect.ScrollUpButton>
                    <RadixSelect.Viewport>
                        <RadixSelect.Group>
                            {label && <RadixSelect.Label className={styles.label}>{label}</RadixSelect.Label>}
                            {items.map((item) => (
                                <RadixSelect.Item
                                    key={item.value}
                                    value={item.value}
                                    disabled={item.disabled}
                                    className={styles.item}
                                >
                                    <RadixSelect.ItemText>{item.label}</RadixSelect.ItemText>
                                    <RadixSelect.ItemIndicator className={styles.itemIndicator}>
                                        <CheckIcon />
                                    </RadixSelect.ItemIndicator>
                                </RadixSelect.Item>
                            ))}
                        </RadixSelect.Group>
                    </RadixSelect.Viewport>
                    <RadixSelect.ScrollDownButton className={styles.scrollButton}>
                        <ChevronDownIcon />
                    </RadixSelect.ScrollDownButton>
                </RadixSelect.Content>
            </RadixSelect.Portal>
        </RadixSelect.Root>
    );
}
