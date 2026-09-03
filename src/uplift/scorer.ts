import { z } from 'zod'

const linearScorerSchema = z.object({
  kind: z.literal('linear'),
  bias: z.number(),
  weights: z.array(z.number()),
  means: z.array(z.number()),
  scales: z.array(z.number()),
})

const treeSchema = z.object({
  feature: z.array(z.number().int()),
  threshold: z.array(z.number()),
  left: z.array(z.number().int()),
  right: z.array(z.number().int()),
  value: z.array(z.number()),
})

const treeEnsembleScorerSchema = z.object({
  kind: z.literal('tree_ensemble'),
  baseScore: z.number(),
  learningRate: z.number(),
  trees: z.array(treeSchema),
})

export const scorerSchema = z.discriminatedUnion('kind', [
  linearScorerSchema,
  treeEnsembleScorerSchema,
])

export type LinearScorer = z.infer<typeof linearScorerSchema>
export type Tree = z.infer<typeof treeSchema>
export type TreeEnsembleScorer = z.infer<typeof treeEnsembleScorerSchema>
export type Scorer = z.infer<typeof scorerSchema>

export class ScorerError extends Error {
  override readonly name = 'ScorerError'
}

const MAX_TREE_DEPTH = 128

function scoreLinear(scorer: LinearScorer, row: readonly number[]): number {
  let total = scorer.bias
  for (let index = 0; index < scorer.weights.length; index++) {
    const mean = scorer.means[index] ?? 0
    const scale = scorer.scales[index] ?? 1
    total += (scorer.weights[index] ?? 0) * (((row[index] ?? 0) - mean) / scale)
  }
  return total
}

function scoreTree(tree: Tree, row: readonly number[]): number {
  let node = 0

  for (let step = 0; step < MAX_TREE_DEPTH; step++) {
    const feature = tree.feature[node]
    if (feature === undefined) {
      throw new ScorerError(`tree node ${node} is missing; the exported model is truncated`)
    }
    if (feature < 0) return tree.value[node] ?? 0

    const threshold = tree.threshold[node] ?? 0
    const next = (row[feature] ?? 0) <= threshold ? tree.left[node] : tree.right[node]
    if (next === undefined || next === node) {
      throw new ScorerError(`tree node ${node} does not descend; the exported model is malformed`)
    }
    node = next
  }

  throw new ScorerError(
    `tree traversal exceeded ${MAX_TREE_DEPTH} levels, which means the exported tree has a cycle`,
  )
}

export function rawScore(scorer: Scorer, row: readonly number[]): number {
  if (scorer.kind === 'linear') return scoreLinear(scorer, row)

  let total = scorer.baseScore
  for (const tree of scorer.trees) total += scorer.learningRate * scoreTree(tree, row)
  return total
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const exponent = Math.exp(z)
  return exponent / (1 + exponent)
}

export function scorerWidth(scorer: Scorer): number | undefined {
  if (scorer.kind === 'linear') return scorer.weights.length

  let widest = -1
  for (const tree of scorer.trees) {
    for (const feature of tree.feature) widest = Math.max(widest, feature)
  }
  return widest < 0 ? undefined : widest + 1
}
