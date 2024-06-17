---
title: AI explainability in clinical settings needs work
date: 2024-05-28
tags: healthcare artificial-intelligence
pinned: true
description: This blog post explores the limitations and challenges of machine learning explainability in clinical settings. It discusses the historical context and current regulations driving the need for explainable AI in healthcare, highlighting real-world examples where explainability methods like SHAP fall short. The post examines the disparity between what clinicians need from AI explanations and what they actually receive, shedding light on the democratization of explainability tools and the potential dangers of oversimplified explanations. It also considers alternative approaches, such as leveraging AI for collaborative workflows, and reflects on the future of explainability methods in improving clinical decision-making.
---

We all know the blurb when it comes to explaining machine learning models in healthcare. Clinicians need to understand the reasons behind predictions when these models are used in care delivery. This need has been top-of-mind since the first days of ML in clinical settings, since atleast 1991, when [William Baxt used a neural network to predict myocardial infarction](https://www.acpjournals.org/doi/abs/10.7326/0003-4819-115-11-843?journalCode=aim) in the emergency department. Now, just recently, the European Union passed a regulatory framework for AI systems, which requires providers to include explainability modules (and meticulous documentation) in offerings.

Despite all the progress in explainable AI, its current state is still lacking. Don't take my word for it - the sentiment is shared by both ML researchers and clinicians using them in practice. For example, [a system tested at UPMC for treatment recommendations](https://dl.acm.org/doi/pdf/10.1145/3544548.3581075) found clinicians quick to dismiss predictions when they couldn't reconcile the model's explanation with their understanding of evidence-based practices. One clinician even said, "...she’s not hypotensive. So why in the world is the AI asking me to start pressors? I’m rapidly losing faith in Sepsis AI". It wouldn't be the first time.

Explainable AI in clinical settings has been underwhelming and potentially unreliable for atleast two reasons. First, current methods fall short in giving the kind of explanations that clinicians need. And second, explainability has been democratized into off-the-shelf open-source tools. Inner workings are now abstracted away, meaning AI product developers and clinical data scientists no longer need to deeply understand the intricacies of the methods (I'll admit I've been guilty of this). As a result, developers and data scientists lack the mental models necessary to effectively communicate limitations to clinicians.

Interfaces showing predictions to end-users are pretty standardized. There's an outcome, like an adverse event like hospitalization or onset of disease, and a patient score, which comes from the model. With with each score, there's a list of "features" (also called variables, predictors, or factors) that were determined to be important to the model - the so-called "contributing factors" to the prediction.

<figure class="wide" style="padding-top: 0em">
<img src="/assets/images/phf.png"/>
<figcaption style="text-align: left">
    The top image is from <a href="https://www.youtube.com/watch?v=1eW1AxieoAk&t=685s">ClosedLoop AI's platform</a>. It shows a timeline view of a patient's risk. The model's score is at the top right corner (96%), and the two widgets at the bottom left show contributing factors for predictions at two different times.

    The bottom left image is from <a href="https://vimeo.com/928387381/8959cf9c85?share=copy">HDAI's platform</a>. Each row represents a different model. The first column is the model's outcome, the second and third columns are the model's score, and the last column is the contributing factors.

    The bottom right image is from a <a href="https://scottsdaleinstitute.org/wp-content/uploads/2021/12/Using-AI-to-Empower_2022.pdf">Stanford publication</a>, where they piloted of two ML models for an advanced care planning team.

</figcaption>

</figure>

To surface "contributing factors", AI developers have rallied around one particular method called [SHAP](https://papers.nips.cc/paper_files/paper/2017/file/8a20a8621978632d76c43dfd28b67767-Paper.pdf). SHAP is part of a larger family of techniques for determining "variable importance," which itself falls under the broader category of model explainability. SHAP became mainstream around 2019 primarily because of its breakthroughs in speed and the [high-quality software](https://shap.readthedocs.io/en/latest/) released by its creators.

DataRobot (a platform for building AI models for various use cases), [describes SHAP's role](https://docs.datarobot.com/en/docs/modeling/analyze-models/understand/pred-explain/shap-pe.html):

> SHAP-based explanations help identify the impact on the decision for each factor.

The problems begin immediately. What does it mean for something to "impact" a black-box model?

## What clinicians need from explanations

Before addressing that, we should probably know why we need explanations in the first place.

Imagine a clinician in the emergency department. They get an alert from a model indicating a patient is at immediate risk of cardiac arrest. They're surprised, since they had just evaluated the patient minutes before, and they hadn't suspect this. The clinician acts on the model's alert - they administer vasopressors and fluids, even though the risk isn't clear to them. When the patient later asks about this, the clinician will need to give an evidence-based explanation. Accountability is the first reason we need explanations. "The model alerted me" isn't insufficient because models aren't 100% accurate. Yes, they often outperform human judgment, but they're not infallible. Understanding reasons behind a prediction helps identify when it might be wrong.

At a minimum, an explanation should include a statement explaining the model's behavior for a prediction. For simple models, this is straightforward. For example, a simple tree like the one below can be easily followed.

<figure>
<img src="/assets/images/cart.png" style="width: 100%"/>
<figcaption style="text-align: left">
Each path in the tree represents a sequence of conditions leading to a final score. In this example, the outcome being scored is the patient's likelihood of needing a tracheostomy (a kind of surgery). The tree was trained over patients with spinal cord injuries. To score a patient, start at the top node and follow the appropriate path based on the patient's charcteristics. Let's walk through one - the top node checks if a patient has a grade A injury (as classified by the American Spinal Injury Association scale). If the patient has a grade A injury and was intubated in the ER, this model is very confident (100% confident infact) that this patient will need surgery. See <a href="https://pubmed.ncbi.nlm.nih.gov/28447274/"> publication</a>. 
</figcaption>
</figure>

ML models used in production are far more complex. [Gradient boosted trees](https://en.wikipedia.org/wiki/Gradient_boosting) can have hundreds of trees, each much longer than the example. There is no single-paragraph summary to internalize this model's behavior. There are far too many calculations done for a single patient for anyone to comprehend.

And so this is the grand endeavor of explainability. Can we summarize these thousands of calculations—perhaps discarding less important details—into a fairly accurate summary? We may not understand everything the model is doing, but if we can get a synopsis, we are in luck.

Particularily in clinical settings, there's also a need to [reconcile the model's behavior with evidence-based practices](https://arxiv.org/pdf/1905.05134). This might actually be more important than understanding the model's behavior because clinical evidence enables clinical action.

There's little consensus on the exact question that explainability should answer about model behavior. Some argue that only a causal account of why the model made a particular prediction—"Why did the model predict outcome Y instead of alternative Z for this patient?"—[is satisfactory](https://link.springer.com/article/10.1007/s11229-022-03485-5). This opens a can-of-worms about what makes a good explanation, which I'll leave to the logicians and philosophers. We might find that SHAP is inconsistent at describing even simple model behavior for an outcome, let alone distinguishing between different outcomes.

## What clinicians are actually getting from explanations

Let's investigate what DataRobot says about converting SHAP values to statements about model behavior.

> The [SHAP] contribution describes how much each listed feature is responsible for pushing the target away from the average.
>
> ...
>
> They answer why a model made a certain prediction—What drives a customer's decision to buy—age? gender? buying habits?

So higher SHAP values correspond to features that drive the prediction higher, while lower SHAP values correspond to features that drive it lower. It seems like we should be able to tell our clinician: "_The model predicted outcome X because of features A, B, and C_."

This seems like a reasonable and potentially useful. Except that recent research questions whether it's actually accurate. When we test the model, its behavior doesn't seem to align with how SHAP says it should. There's several known cases where SHAP fails to capture basic model behavior.

- [SHAP values can show a feature as important even if the model doesn't use it directly. This happens when this unused feature correlates with other important features](https://arxiv.org/pdf/1909.08128). Example: [a UW study trained a model to predict mortality using CDC data, where the final model didn't use BMI](https://arxiv.org/pdf/2006.16234), but SHAP still assigned BMI a non-zero, positive importance. This happens because [SHAP distributes importance between correlated features](https://arxiv.org/pdf/1903.10464).
- Because SHAP splits importance between correlated features, [key features the model relies on might appear less important](https://arxiv.org/pdf/2303.05981)
- [SHAP values don't indicate how a model's predictions will change if feature values are adjusted](https://arxiv.org/pdf/2212.11870). Example: a Stanford study used ML to predict survival outcomes in a clinical trial based on patient eligibility criteria. The author's concluded that "Shapley values close to zero [...] correspond to eligibility criteria that had no effect on [...] the overall survival." In other words, they expected that changing these criteria wouldn't affect the prediction. You can test this: change the eligibility criteria and we should expect the survival score to change. Recent research from the University of Toronto found that this expectation is completely unjustified. SHAP values don't reliably tell you how changes in features will affect the model's output. The key insight here is that, with SHAP, we have no causal understanding of model behavior. The claim that the "model predicted X because this patient has characteristic Y" is invalid because it implies "if we change characteristic Y, the model should no longer predict X".

Now what? Is SHAP just a crap approach to explainability? Or are DataRobot's documents incorrect? We should revisit some fundamental perspectives on explainability that are often overlooked in the race to build production-ready products.

## How accurate can we really expect explainability to be?

SHAP and similar explainability methods offer post-hoc rationales for black-box model predictions. These rationales are based on approximations of the model.

Since these explanations are approximations, they will inevitably be incorrect at times and cannot perfectly replicate the model's behavior for all patients. If explainability methods could perfectly replicate the original model's calculations, we would never need the original model, we could just use the explainable model. Even if an explanation method is accurate for 90% of cases, it will still be wrong for 10%. Quantifying the error rate is still an open research problem, and so is identifying when and for whom the explanations fail. This uncertainty makes explanation methods and black-box models unreliable in high-stakes environments. Therefore, calling them "explanations" might be misleading; a more accurate term could be "[summary of prediction trends](https://arxiv.org/pdf/1811.10154)."

To see this perspective play out in understanding SHAP's limitations, let's look at how SHAP values are computed. SHAP values determine feature importance by analyzing the model's behavior when certain features are "unknown," using different combinations to see their impact on predictions. Making features "unknown" is a key innovation of SHAP. Accurately evaluating the model's behavior without certain features would require retraining the model multiple times, which is computationally infeasible. SHAP approximates this process, which is both its innovative strength and its primary limitation.

## The downsides of democratizing explainability

As I mentioned before, the creators of SHAP released excellent software, allowing practitioners to use it without needing to understand the intricate details. However, SHAP is not a simple algorithm. It is based on principles from game theory developed by Nobel Prize winner Lloyd Shapley and includes several detailed algorithmic choices with significant implications. Despite SHAP's mainstream adoption, it is often assumed to be a complete solution when, in reality, it is still a work in progress. Again, I'll admit my own guilt here. There is concern that these methods might only be used correctly by algorithmic experts. Average users might fall into confirmation bias and develop incomplete mental models, leading to overtrusting the tool.

Another example. [In 2015, Mount Sinai used an ML model to triage pneumonia patients](https://link.springer.com/article/10.1007/s11229-022-03485-5). The model had excellent accuracy, but they eventually noticed something peculiar -- it assigned a low probability of mortality to patients with asthma, which contradicted clinical intuition. Had they used SHAP values, they would've found that the presence of asthma drives the prediction score down, and clinicians might have said something like: "The model predicts a low mortality score for this patient because they have asthma." They later discovered that historically, asthmatics with pneumonia were sent to the ICU due to their high risk, where the extra attention they received reduced their overall probability of death.

Though this issue reflects a problem with ML models rather than explainability methods specifically, it shows a human tendency with explainability methods in counterintuitive situations. In these cases, confusing results are sometimes dismissed, especially in clinical environments where models are expected to provide new insights into disease management or physiology. [People tend to rationalize that machine learning models process data differently from humans and rely on "a lot of complex math" to uncover things we might not fully understand](https://harmanpk.github.io/Papers/CHI2020_Interpretability.pdf). In the case of Mount Sinai, this could have been dangerous.

Effective data science teams vet their models for explainability, involving the clinical team using the model. Still, I don't see how its possible for all failure cases can be identified before deployment.

[Some](https://arxiv.org/pdf/1811.10154) [researchers](https://borisbabic.com/research/beware_march2023.pdf) have called for abandoning black-box models in favor of simpler, naturally interpretable models. [Others](https://link.springer.com/article/10.1007/s11229-022-03485-5) [suggest](https://arxiv.org/pdf/2007.04131) using multiple explainability methods together, leveraging their strengths and weaknesses, in a way that allows the end-user to interact with an end-system. I don't see how such a system would be feasible in a clinical envrionment - no clinician would want to spend 15 minutes inside a portal reviewing comprehensive explainability modules with multiple interfaces. Perhaps with multi-agent LLMs becoming more robust, we will see a system where these LLMs, much like how they are used to write code and build apps with a human-in-the-loop, can use multiple explainability methods through an interactive interface to provide a deeper understanding of model behavior.

We've got to ask ourselves: can we live without explainability? Do predictive models lose all value if we can't trust their explanations?

## A different approach: using AI to structure workflows.

Whatever qualms you may have about explainability, there is no denying that ML offers benefits in accuracy compared to clinicians when it comes to predicting outcomes.

How can we leverage this benefit without depending on explainability? Lessons learned from [a deployment done by Stanford offers a new perspective](https://scottsdaleinstitute.org/wp-content/uploads/2021/12/Using-AI-to-Empower_2022.pdf).

In 2022, Stanford deployed AI systems at Stanford Health used for surfacing seriously ill hospitalized patients who may benefit from advanced care planning (ACP). ACP helps clinicians identify patients who might benefit from palliative or hospice care. From their previous experience with clinical AI systems and feedback from clinicians, the authors knew the concerns clinicians have about AI, like how clinicians often disagree with ML predictions or feel the AI doesn't provide new insights.

Stanford, in this deployment, emphasized AI's utility in structuring collaborative workflows, rather than being correct or offering new insights. The AI model acts as a "mediator", helping clinicians and nurses adopt a shared mental model of risk. The AI serves as an objective, initial assessor of risk. The motivation for this was an issue that they surfaced from stakeholder interviews - clinicians often noted that, in multidisciplinary teams, there is hesitation to take action due to disagreements between physicians and nurses assessment of a patients risk, which can lead to missed ACP opportunities.

Again, the AI's role here is not about delivering detailed insights or ensuring agreement on individual predictions. In fact, the alerts generated by Stanford's model do not even mention contributing factors. The AI model is just the first step in assessing risk. The alert triggers an assessment protocol—a "serious illness conversation guide"—where a nurse assesses the patient's needs and goals, deciding on additional care management initiatives.

The approach still allows better allocation of resources by directing nurses to patients who would benefit most from ACP, addressing the issue of limited nursing resources and avoiding unnecessary ACP for patients who do not need it.
