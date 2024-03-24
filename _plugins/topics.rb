module Jekyll
    class TopicPage < Page
      def initialize(site, base, dir, topic, notes)
        @site = site
        @base = base
        @dir = dir
        @name = 'index.html'
  
        self.process(@name)
        self.read_yaml(File.join(base, '_layouts'), 'topic.html')
        self.data['title'] = topic
        self.data['topic'] = TopicPageGenerator.process_topic(topic)
        self.data['notes'] = notes 
      end
    end
  
    class TopicPageGenerator < Generator
      safe true

      # preprocess topic variable
      def self.process_topic(topic)
        if topic == 'health-it'
          'Health-IT'
        else
          topic.capitalize
        end
      end
  
      def generate(site)
        # Aggregate all tags from notes
        all_tags = site.collections['notes'].docs.flat_map { |note| note.data['tags'] || [] }.uniq
  
        # Generate a page for each tag
        all_tags.each do |tag|
          notes_for_tag = site.collections['notes'].docs.select { |note| note.data['tags'].include?(tag) }
          site.pages << TopicPage.new(site, site.source, File.join('topics', Jekyll::Utils.slugify(tag)), tag, notes_for_tag)
        end
      end
    end
  end
  