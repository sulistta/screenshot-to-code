## Correção do bug: popovers do ModelPicker e Mode se sobrescrevem na ConfigBar

### Causa raiz

Em `frontend/src/components/studio/StudioPage.tsx`, dentro de `ConfigBar`:

- Linha 126: `const [editing, setEditing] = useState(false);` é um único booleano usado para DOIS propósitos conflitantes.
- Linhas 152–167: `editing` decide se a `ConfigBar` mostra o resumo colapsado ("Best available · Auto") ou a linha expandida com os 3 botões.
- Linha 184: `<Popover open={editing} onOpenChange={setEditing}>` — o MESMO `editing` é ligado como `open` e como `onOpenChange` do popover de Mode.

Por causa disso:
- O Radix trata cliques em qualquer lugar fora do popover de Mode como "outside click" e dispara `onOpenChange(false)` → `setEditing(false)` → a `ConfigBar` colapsa para o resumo E o popover de Mode reabre por baixo.
- Como `ModelPicker.tsx:25` já usa corretamente seu próprio `useState`, o problema é exclusivo de `ConfigBar`.

### Padrão correto já existente

`ModelPicker.tsx:25` faz exatamente o que precisamos:
```tsx
const [open, setOpen] = useState(false);
```

Cada popover controla seu próprio estado de abertura. Nenhum outro arquivo do `frontend/` precisa ser tocado.

### Plano de implementação

Arquivo único a modificar: `frontend/src/components/studio/StudioPage.tsx`, dentro da função `ConfigBar` (linhas 122–240).

**Mudança 1 — separar os dois estados** (substituir a linha 126):
```tsx
// Antes
const [editing, setEditing] = useState(false);

// Depois
const [editing, setEditing] = useState(false);
const [modeOpen, setModeOpen] = useState(false);
```

**Mudança 2 — desacoplar o popover de Mode de `editing`** (substituir a linha 184):
```tsx
// Antes
<Popover open={editing} onOpenChange={setEditing}>

// Depois
<Popover open={modeOpen} onOpenChange={setModeOpen}>
```

**Mudança 3 — não colapsar a `ConfigBar` quando uma opção de Mode é escolhida** (substituir linhas 213–216):
```tsx
// Antes
onClick={() => {
  save({ executionMode: mode });
  setEditing(false);
}}

// Depois
onClick={() => {
  save({ executionMode: mode });
  setModeOpen(false);
}}
```

(Comportamento desejado: escolher um modo apenas fecha o popover; o usuário continua na `ConfigBar` expandida e clica "Done" explicitamente para fechar — assim como acontece ao escolher um modelo no `ModelPicker`.)

Os outros usos de `setEditing` (linhas 156, 234) permanecem exatamente como estão: o botão de resumo `setEditing(true)` e o botão "Done" `setEditing(false)` continuam controlando o colapso/expansão da barra, que é o propósito original de `editing`.

### Verificação pós-mudança

Não existem testes para `ConfigBar`, `ModelPicker` ou `StudioPage` (`frontend/src/store/studio-store.test.ts` é o único teste e não toca UI). Apenas:

1. `cd frontend && pnpm lint` (alinhado com a política em `AGENTS.md`).

### O que NÃO será alterado

- `ModelPicker.tsx` — já está correto.
- `ui/popover.tsx` — Radix puro, sem customização.
- `studio-store.ts` — nenhum estado de UI precisa ser promovido para a store; manter local segue o padrão existente.
- `StudioPage.tsx` fora da `ConfigBar`.

### Resultado esperado após o fix

- Clicar no trigger do `ModelPicker` abre só o popover de modelo, sem interferir no popover de Mode (que continua fechado).
- Selecionar um modelo fecha o popover de modelo e mantém a `ConfigBar` expandida, pronto para outra escolha ou para fechar com "Done".
- Clicar no trigger de Mode abre só o popover de Mode; clicar fora ou escolher uma opção fecha só esse popover, sem colapsar a barra (igual ao comportamento do `ModelPicker`).
- A `ConfigBar` só colapsa para o resumo quando o usuário clica "Done" (ou quando ela é re-renderizada a partir do estado fechado).