module Jekyll
    class TagsGenerator < Generator
      safe true
      priority :low
  
      def generate(site)
        all_tags = []
  
        site.collections['notes'].docs.each do |doc|
          all_tags.concat(doc.data['tags'] || [])
        end
  
        site.data['unique_tags'] = all_tags.uniq.sort
      end
    end
  end
  