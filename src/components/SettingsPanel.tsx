import { useEffect, useState } from "react";
import { Settings, RefreshCw, Wifi, WifiOff, Brain, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  type LLMConfig,
  type LLMProvider,
  fetchModels,
  getDefaultConfig,
  saveConfig,
} from "@/lib/llm-service";

interface Props {
  config: LLMConfig;
  onChange: (c: LLMConfig) => void;
}

export function SettingsPanel({ config, onChange }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const m = await fetchModels(config);
    setModels(m);
    setConnected(m.length > 0);
    if (m.length > 0 && !config.model) {
      const updated = { ...config, model: m[0] };
      onChange(updated);
      saveConfig(updated);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (config.host && config.port) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.provider, config.host, config.port]);

  useEffect(() => {
    // Auto-fetch models on first mount if no model is selected yet
    if (!config.model && config.host && config.port) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<LLMConfig>) => {
    let updated = { ...config, ...patch };
    if (patch.provider) {
      const d = getDefaultConfig(patch.provider as LLMProvider);
      updated = { ...updated, host: d.host, port: d.port, model: "" };
    }
    onChange(updated);
    saveConfig(updated);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 relative">
          <Settings className="h-4 w-4" />
          <span className="hidden sm:inline">LLM Admin</span>
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-primary" : "bg-destructive"}`}
            aria-hidden
          />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Local LLM Admin</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs">
            {connected ? (
              <>
                <Wifi className="h-3.5 w-3.5 text-primary" />
                <span className="text-primary font-mono">Connected</span>
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5 text-destructive" />
                <span className="text-destructive font-mono">Not reachable</span>
              </>
            )}
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Provider
            </Label>
            <Select value={config.provider} onValueChange={(v) => update({ provider: v as LLMProvider })}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ollama">Ollama</SelectItem>
                <SelectItem value="lmstudio">LM Studio</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Host</Label>
              <Input
                value={config.host}
                onChange={(e) => update({ host: e.target.value })}
                className="mt-1 font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Port</Label>
              <Input
                value={config.port}
                onChange={(e) => update({ port: e.target.value })}
                className="mt-1 font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Model</Label>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refresh} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
            <Select value={config.model} onValueChange={(v) => update({ model: v })}>
              <SelectTrigger className="mt-1 font-mono text-xs">
                <SelectValue placeholder={models.length ? "Choose a model" : "No models found"} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-xs">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <Label className="text-xs flex items-center gap-2">
              <Brain className="h-4 w-4" /> Extended reasoning
            </Label>
            <Switch
              checked={config.thinking ?? false}
              onCheckedChange={(v) => update({ thinking: v })}
            />
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Lex talks directly to your local model. Nothing leaves your machine — make sure
            Ollama or LM Studio is running and CORS is enabled for browser access.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
