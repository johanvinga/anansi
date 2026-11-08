import type { FormEvent } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

interface SearchFormProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  placeholder?: string;
}

/** Search box with a leading icon, used in list toolbars. */
export function SearchForm({ label, value, onChange, onSearch, placeholder }: SearchFormProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch();
  }

  return (
    <form role="search" className="flex w-full max-w-md items-center gap-2" onSubmit={handleSubmit}>
      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          name="q"
          aria-label={label}
          placeholder={placeholder ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </InputGroup>
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}
